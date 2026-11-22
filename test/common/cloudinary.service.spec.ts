import {
  BadRequestException,
  InternalServerErrorException,
} from '@nestjs/common';
import {
  CloudinaryService,
  type UploadedImageFile,
} from '../../src/common/cloudinary.service';
import { ExpensesService } from '../../src/expenses/expenses.service';
import { FamilyService } from '../../src/family/family.service';
import { FirebaseService } from '../../src/firebase/firebase.service';
import { COLLECTIONS, UserDoc } from '../../src/firebase/firebase.types';
import { UsersService } from '../../src/users/users.service';
import { InMemoryFirebaseService } from '../__mocks__/firebase.service.mock';

function makePngBuffer(size = 64): Buffer {
  const buf = Buffer.alloc(size, 0);
  // PNG magic header: 89 50 4E 47 0D 0A 1A 0A
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0);
  return buf;
}

function makeJpegBuffer(size = 64): Buffer {
  const buf = Buffer.alloc(size, 0);
  buf[0] = 0xff;
  buf[1] = 0xd8;
  buf[2] = 0xff;
  buf[3] = 0xe0;
  return buf;
}

function makeWebpBuffer(size = 64): Buffer {
  const buf = Buffer.alloc(size, 0);
  Buffer.from('RIFF').copy(buf, 0);
  Buffer.from('WEBP').copy(buf, 8);
  return buf;
}

function makeImageFile(
  buffer: Buffer,
  mimetype = 'image/png',
  originalname = 'photo.png',
): UploadedImageFile {
  return {
    fieldname: 'file',
    originalname,
    encoding: '7bit',
    mimetype,
    size: buffer.length,
    buffer,
  };
}

describe('CloudinaryService & Media Lifecycle Cleanup', () => {
  const origEnv = { ...process.env };
  const origFetch = global.fetch;

  beforeEach(() => {
    process.env.CLOUDINARY_CLOUD_NAME = 'demo-cloud';
    process.env.CLOUDINARY_API_KEY = 'demo-key';
    process.env.CLOUDINARY_API_SECRET = 'demo-secret';
    process.env.FIREBASE_ENV = 'development';
  });

  afterEach(() => {
    process.env = { ...origEnv };
    global.fetch = origFetch;
    jest.restoreAllMocks();
  });

  describe('CloudinaryService validation & signed requests', () => {
    it('accepts valid PNG, JPEG and WEBP buffers by magic bytes', () => {
      const svc = new CloudinaryService();
      expect(svc.validateImageFile(makeImageFile(makePngBuffer())).ext).toBe('png');
      expect(svc.validateImageFile(makeImageFile(makeJpegBuffer())).ext).toBe('jpg');
      expect(svc.validateImageFile(makeImageFile(makeWebpBuffer())).ext).toBe('webp');
    });

    it('rejects SVG XSS payloads disguised as images and files above 3 MB', () => {
      const svc = new CloudinaryService();
      const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
      expect(() =>
        svc.validateImageFile(makeImageFile(svg, 'image/svg+xml', 'xss.svg')),
      ).toThrow(BadRequestException);

      const oversized = makePngBuffer(3 * 1024 * 1024 + 10);
      expect(() => svc.validateImageFile(makeImageFile(oversized))).toThrow(
        BadRequestException,
      );
    });

    it('uploads image with signed payload into dev folder and ignores unsafe delete publicIds', async () => {
      const fetchMock = jest.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          secure_url: 'https://res.cloudinary.com/demo-cloud/image/upload/v1/painel-monet/dev/avatars/u-1/photo.png',
          public_id: 'painel-monet/dev/avatars/u-1/photo',
        }),
      });
      global.fetch = fetchMock as unknown as typeof fetch;

      const svc = new CloudinaryService();
      const uploaded = await svc.uploadImage(
        makeImageFile(makePngBuffer()),
        'avatars',
        'u-1',
      );

      expect(uploaded.publicId).toBe('painel-monet/dev/avatars/u-1/photo');
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('https://api.cloudinary.com/v1_1/demo-cloud/image/upload');
      expect(init.method).toBe('POST');

      // Traversal / prefix outside painel-monet/ must never call Cloudinary destroy
      await svc.deleteImage('../../other/folder');
      await svc.deleteImage('other-app/photo');
      expect(fetchMock).toHaveBeenCalledTimes(1);

      // Valid painel-monet publicId triggers signed destroy
      await svc.deleteImage('painel-monet/dev/avatars/u-1/old-photo');
      expect(fetchMock).toHaveBeenCalledTimes(2);
      const [destroyUrl, destroyInit] = fetchMock.mock.calls[1] as [string, RequestInit];
      expect(destroyUrl).toBe('https://api.cloudinary.com/v1_1/demo-cloud/image/destroy');
      expect(String(destroyInit.body)).toContain('public_id=painel-monet%2Fdev%2Favatars%2Fu-1%2Fold-photo');
    });

    it('throws InternalServerErrorException when Cloudinary env vars are missing', async () => {
      delete process.env.CLOUDINARY_CLOUD_NAME;
      const svc = new CloudinaryService();
      await expect(
        svc.uploadImage(makeImageFile(makePngBuffer()), 'expenses', 'u-1'),
      ).rejects.toThrow(InternalServerErrorException);
    });
  });

  describe('UsersService & ExpensesService automatic Cloudinary cleanup', () => {
    let firebase: InMemoryFirebaseService;
    let cloudinaryMock: {
      uploadImage: jest.Mock;
      deleteImage: jest.Mock;
    };
    let usersService: UsersService;
    let expensesService: ExpensesService;

    beforeEach(async () => {
      firebase = new InMemoryFirebaseService();
      cloudinaryMock = {
        uploadImage: jest.fn(),
        deleteImage: jest.fn().mockResolvedValue(undefined),
      };

      const user: UserDoc = {
        id: 'u-media',
        name: 'Igor Media',
        email: 'igor.media@test.com',
        cpf: '52998224725',
        phone: '11999990000',
        firebaseUid: 'fb-media',
        authProvider: 'password',
        isActive: true,
        deactivatedAt: null,
        deactivatedAtMs: null,
        emergencyFund: 0,
        externalEmergencyFund: 0,
        investments: 0,
        externalInvestments: 0,
        foodAllowance: 0,
        avatarUrl: 'https://res.cloudinary.com/demo/old-avatar.png',
        avatarPublicId: 'painel-monet/dev/avatars/u-media/old-avatar',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      };
      await firebase.setDoc(COLLECTIONS.USERS, user);
      await firebase.setDoc(COLLECTIONS.ACCOUNT_TYPES, {
        id: 'cat-1',
        name: 'Mercado',
        userId: 'u-media',
        createdAt: '',
        updatedAt: '',
      });

      const familyStub: Pick<
        FamilyService,
        'resolveAuthorizedScope' | 'notifyFamilyDataChanged'
      > = {
        resolveAuthorizedScope: jest.fn().mockResolvedValue({
          mode: 'individual',
          userIds: ['u-media'],
          userMap: new Map(),
          familyGroupId: null,
        }),
        notifyFamilyDataChanged: jest.fn().mockResolvedValue(undefined),
      };

      usersService = new UsersService(
        firebase as unknown as FirebaseService,
        undefined,
        cloudinaryMock as unknown as CloudinaryService,
      );
      expensesService = new ExpensesService(
        firebase as unknown as FirebaseService,
        familyStub as unknown as FamilyService,
        undefined,
        cloudinaryMock as unknown as CloudinaryService,
      );
    });

    it('deletes previous avatar on replace and on explicit avatar removal', async () => {
      cloudinaryMock.uploadImage.mockResolvedValueOnce({
        url: 'https://res.cloudinary.com/demo/new-avatar.png',
        publicId: 'painel-monet/dev/avatars/u-media/new-avatar',
      });

      const replaced = await usersService.updateAvatar(
        'u-media',
        makeImageFile(makePngBuffer()),
      );
      expect(replaced.avatarUrl).toBe('https://res.cloudinary.com/demo/new-avatar.png');
      expect(cloudinaryMock.deleteImage).toHaveBeenCalledWith(
        'painel-monet/dev/avatars/u-media/old-avatar',
      );

      const removed = await usersService.removeAvatar('u-media');
      expect(removed.avatarUrl).toBeNull();
      expect(cloudinaryMock.deleteImage).toHaveBeenCalledWith(
        'painel-monet/dev/avatars/u-media/new-avatar',
      );
    });

    it('deletes previous expense receipt on replace, removeReceiptPhoto, and expense deletion', async () => {
      await firebase.setDoc(COLLECTIONS.EXPENSES, {
        id: 'exp-1',
        userId: 'u-media',
        name: 'Nota Mercado',
        accountTypeId: 'cat-1',
        value: 80,
        dueDate: '2026-11-20',
        isRecurring: false,
        isInstallment: false,
        isPaid: true,
        isCreditCard: false,
        receiptUrl: 'https://res.cloudinary.com/demo/exp-old.png',
        receiptPublicId: 'painel-monet/dev/expenses/u-media/exp-old',
        createdAt: '',
        updatedAt: '',
      });
      await firebase.setDoc(COLLECTIONS.EXPENSES, {
        id: 'exp-child',
        userId: 'u-media',
        parentExpenseId: 'exp-1',
        name: 'Parcela Extra',
        accountTypeId: 'cat-1',
        value: 40,
        dueDate: '2026-12-20',
        isRecurring: false,
        isInstallment: true,
        isPaid: false,
        isCreditCard: false,
        receiptUrl: 'https://res.cloudinary.com/demo/exp-child.png',
        receiptPublicId: 'painel-monet/dev/expenses/u-media/exp-child',
        createdAt: '',
        updatedAt: '',
      });

      cloudinaryMock.uploadImage.mockResolvedValueOnce({
        url: 'https://res.cloudinary.com/demo/exp-new.png',
        publicId: 'painel-monet/dev/expenses/u-media/exp-new',
      });

      const updated = await expensesService.uploadReceiptPhoto(
        'exp-1',
        'u-media',
        makeImageFile(makeJpegBuffer(), 'image/jpeg', 'cupom.jpg'),
      );
      expect(updated.receiptUrl).toBe('https://res.cloudinary.com/demo/exp-new.png');
      expect(cloudinaryMock.deleteImage).toHaveBeenCalledWith(
        'painel-monet/dev/expenses/u-media/exp-old',
      );

      await expensesService.remove('exp-1', 'u-media');
      expect(cloudinaryMock.deleteImage).toHaveBeenCalledWith(
        'painel-monet/dev/expenses/u-media/exp-child',
      );
      expect(cloudinaryMock.deleteImage).toHaveBeenCalledWith(
        'painel-monet/dev/expenses/u-media/exp-new',
      );
    });

    it('cleans up avatar and all expense photos when permanently deleting user account', async () => {
      await firebase.setDoc(COLLECTIONS.EXPENSES, {
        id: 'exp-del-1',
        userId: 'u-media',
        name: 'Conta Luz',
        accountTypeId: 'cat-1',
        value: 150,
        dueDate: '2026-11-25',
        isRecurring: false,
        isInstallment: false,
        isPaid: false,
        isCreditCard: false,
        receiptUrl: 'https://res.cloudinary.com/demo/luz.png',
        receiptPublicId: 'painel-monet/dev/expenses/u-media/luz',
        createdAt: '',
        updatedAt: '',
      });

      await usersService.deleteAccountPermanently('u-media', true, 'EXCLUIR');

      expect(cloudinaryMock.deleteImage).toHaveBeenCalledWith(
        'painel-monet/dev/avatars/u-media/old-avatar',
      );
      expect(cloudinaryMock.deleteImage).toHaveBeenCalledWith(
        'painel-monet/dev/expenses/u-media/luz',
      );
    });
  });
});
