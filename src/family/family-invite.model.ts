import {
  Table,
  Column,
  Model,
  DataType,
  PrimaryKey,
  Default,
  ForeignKey,
  BelongsTo,
  BeforeCreate,
} from 'sequelize-typescript';
import { User } from '../users/user.model';
import { FamilyGroup } from './family-group.model';
import { randomUUID as uuidv4 } from 'crypto';

@Table({ tableName: 'family_invites', timestamps: true, underscored: true })
export class FamilyInvite extends Model {
  @PrimaryKey
  @Default(uuidv4)
  @Column(DataType.STRING(36))
  declare id: string;

  @ForeignKey(() => FamilyGroup)
  @Column({ type: DataType.STRING(36), allowNull: false })
  declare familyGroupId: string;

  @BelongsTo(() => FamilyGroup)
  declare familyGroup: FamilyGroup;

  @ForeignKey(() => User)
  @Column({ type: DataType.STRING(36), allowNull: false })
  declare inviterUserId: string;

  @BelongsTo(() => User, { foreignKey: 'inviterUserId', as: 'inviter' })
  declare inviter: User;

  @Column({ type: DataType.STRING(14), allowNull: false })
  declare inviterCpf: string;

  @ForeignKey(() => User)
  @Column({ type: DataType.STRING(36), allowNull: false })
  declare inviteeUserId: string;

  @BelongsTo(() => User, { foreignKey: 'inviteeUserId', as: 'invitee' })
  declare invitee: User;

  @Column({ type: DataType.STRING(14), allowNull: false })
  declare inviteeCpf: string;

  @Default('pending')
  @Column({ type: DataType.STRING(20), allowNull: false })
  declare status: 'pending' | 'accepted' | 'rejected' | 'cancelled';

  @BeforeCreate
  static assignId(instance: FamilyInvite) {
    if (!instance.id) {
      instance.id = uuidv4();
    }
  }
}
