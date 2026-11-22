import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { createHash, randomUUID } from 'crypto';
import { redactSensitiveText } from './data-crypto.utils';

export interface UploadedImageFile {
  fieldname: string;
  originalname: string;
  encoding: string;
  mimetype: string;
  size: number;
  buffer: Buffer;
}

export interface CloudinaryUploadResult {
  url: string;
  publicId: string;
}

const MAX_IMAGE_BYTES = 3 * 1024 * 1024; // 3 MB (compatível com limite de payload serverless da Vercel)

interface DetectedImageType {
  ext: 'jpg' | 'png' | 'webp' | 'gif';
  mime: string;
}

function detectImageTypeByMagicBytes(buf: Buffer): DetectedImageType | null {
  if (!buf || buf.length < 12) return null;

  // JPEG: FF D8 FF
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return { ext: 'jpg', mime: 'image/jpeg' };
  }

  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    buf[0] === 0x89 &&
    buf[1] === 0x50 &&
    buf[2] === 0x4e &&
    buf[3] === 0x47 &&
    buf[4] === 0x0d &&
    buf[5] === 0x0a &&
    buf[6] === 0x1a &&
    buf[7] === 0x0a
  ) {
    return { ext: 'png', mime: 'image/png' };
  }

  // WEBP: "RIFF" + 4 bytes + "WEBP"
  if (
    buf.subarray(0, 4).toString('ascii') === 'RIFF' &&
    buf.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return { ext: 'webp', mime: 'image/webp' };
  }

  // GIF: GIF87a ou GIF89a
  const header6 = buf.subarray(0, 6).toString('ascii');
  if (header6 === 'GIF87a' || header6 === 'GIF89a') {
    return { ext: 'gif', mime: 'image/gif' };
  }

  return null;
}

@Injectable()
export class CloudinaryService {
  private readonly logger = new Logger(CloudinaryService.name);

  private getCredentials(): {
    cloudName: string;
    apiKey: string;
    apiSecret: string;
  } | null {
    const cloudName = process.env.CLOUDINARY_CLOUD_NAME?.trim() || '';
    const apiKey = process.env.CLOUDINARY_API_KEY?.trim() || '';
    const apiSecret = process.env.CLOUDINARY_API_SECRET?.trim() || '';
    if (!cloudName || !apiKey || !apiSecret) {
      return null;
    }
    return { cloudName, apiKey, apiSecret };
  }

  isConfigured(): boolean {
    return this.getCredentials() !== null;
  }

  validateImageFile(file: UploadedImageFile | undefined | null): DetectedImageType {
    if (!file || !file.buffer || file.buffer.length === 0) {
      throw new BadRequestException('Nenhuma imagem foi enviada.');
    }

    if (file.size > MAX_IMAGE_BYTES || file.buffer.length > MAX_IMAGE_BYTES) {
      throw new BadRequestException(
        'A imagem excede o limite máximo de 3 MB.',
      );
    }

    const detected = detectImageTypeByMagicBytes(file.buffer);
    if (!detected) {
      throw new BadRequestException(
        'Arquivo inválido. Envie apenas imagens reais nos formatos JPG, PNG, WEBP ou GIF.',
      );
    }

    return detected;
  }

  private signParams(
    params: Record<string, string>,
    apiSecret: string,
  ): string {
    const query = Object.keys(params)
      .sort()
      .map((key) => `${key}=${params[key]}`)
      .join('&');
    return createHash('sha1').update(`${query}${apiSecret}`).digest('hex');
  }

  async uploadImage(
    file: UploadedImageFile,
    categoryFolder: 'avatars' | 'expenses',
    ownerKey: string,
  ): Promise<CloudinaryUploadResult> {
    const detected = this.validateImageFile(file);
    const creds = this.getCredentials();
    if (!creds) {
      throw new InternalServerErrorException(
        'Armazenamento de imagens (Cloudinary) não configurado neste servidor.',
      );
    }

    const envPrefix =
      (process.env.FIREBASE_ENV || '').trim().toLowerCase() === 'development' ||
      (process.env.FIREBASE_ENV || '').trim().toLowerCase() === 'dev'
        ? 'dev'
        : 'prod';

    const safeOwner = ownerKey.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 48) || 'user';
    const folder = `painel-monet/${envPrefix}/${categoryFolder}/${safeOwner}`;
    const publicId = `${safeOwner}-${randomUUID().slice(0, 12)}`;
    const timestamp = String(Math.floor(Date.now() / 1000));

    const signPayload: Record<string, string> = {
      folder,
      overwrite: 'true',
      public_id: publicId,
      timestamp,
    };
    const signature = this.signParams(signPayload, creds.apiSecret);

    const form = new FormData();
    form.append(
      'file',
      new Blob([new Uint8Array(file.buffer)], { type: detected.mime }),
      `${publicId}.${detected.ext}`,
    );
    form.append('api_key', creds.apiKey);
    form.append('timestamp', timestamp);
    form.append('folder', folder);
    form.append('public_id', publicId);
    form.append('overwrite', 'true');
    form.append('signature', signature);

    const response = await fetch(
      `https://api.cloudinary.com/v1_1/${encodeURIComponent(creds.cloudName)}/image/upload`,
      {
        method: 'POST',
        body: form,
      },
    );

    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      this.logger.error(
        `Falha ao enviar imagem ao Cloudinary (${response.status}): ${redactSensitiveText(errText).slice(0, 200)}`,
      );
      throw new InternalServerErrorException(
        'Não foi possível armazenar a imagem no momento.',
      );
    }

    const data = (await response.json()) as {
      secure_url?: string;
      public_id?: string;
    };
    if (!data.secure_url || !data.public_id) {
      throw new InternalServerErrorException(
        'Resposta incompleta do servidor de imagens.',
      );
    }

    return {
      url: data.secure_url,
      publicId: data.public_id,
    };
  }

  async deleteImage(publicId?: string | null): Promise<void> {
    if (!publicId || typeof publicId !== 'string') return;
    const trimmed = publicId.trim();
    if (!trimmed || trimmed.includes('..') || !trimmed.startsWith('painel-monet/')) {
      return;
    }

    const creds = this.getCredentials();
    if (!creds) return;

    const timestamp = String(Math.floor(Date.now() / 1000));
    const signPayload: Record<string, string> = {
      invalidate: 'true',
      public_id: trimmed,
      timestamp,
    };
    const signature = this.signParams(signPayload, creds.apiSecret);

    const body = new URLSearchParams({
      public_id: trimmed,
      timestamp,
      invalidate: 'true',
      api_key: creds.apiKey,
      signature,
    });

    try {
      const response = await fetch(
        `https://api.cloudinary.com/v1_1/${encodeURIComponent(creds.cloudName)}/image/destroy`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: body.toString(),
        },
      );
      if (!response.ok) {
        const errText = await response.text().catch(() => '');
        this.logger.warn(
          `Falha ao remover imagem antiga do Cloudinary (${response.status}): ${redactSensitiveText(errText).slice(0, 160)}`,
        );
      }
    } catch (error) {
      this.logger.warn(
        `Erro ao excluir imagem do Cloudinary: ${
          error instanceof Error ? redactSensitiveText(error.message) : 'erro desconhecido'
        }`,
      );
    }
  }
}
