import { Global, Module } from '@nestjs/common';
import { AuditService } from '../common/audit.service';
import { CloudinaryService } from '../common/cloudinary.service';
import { FirebaseService } from './firebase.service';

@Global()
@Module({
  providers: [FirebaseService, AuditService, CloudinaryService],
  exports: [FirebaseService, AuditService, CloudinaryService],
})
export class FirebaseModule {}
