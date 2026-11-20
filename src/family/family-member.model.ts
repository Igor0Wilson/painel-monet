import {
  Table,
  Column,
  Model,
  DataType,
  PrimaryKey,
  Default,
  Unique,
  ForeignKey,
  BelongsTo,
  BeforeCreate,
} from 'sequelize-typescript';
import { User } from '../users/user.model';
import { FamilyGroup } from './family-group.model';
import { randomUUID as uuidv4 } from 'crypto';

@Table({ tableName: 'family_members', timestamps: true, underscored: true })
export class FamilyMember extends Model {
  @PrimaryKey
  @Default(uuidv4)
  @Column(DataType.STRING(36))
  declare id: string;

  @ForeignKey(() => FamilyGroup)
  @Column({ type: DataType.STRING(36), allowNull: false })
  declare familyGroupId: string;

  @BelongsTo(() => FamilyGroup)
  declare familyGroup: FamilyGroup;

  @Unique
  @ForeignKey(() => User)
  @Column({ type: DataType.STRING(36), allowNull: false })
  declare userId: string;

  @BelongsTo(() => User)
  declare user: User;

  @Column({ type: DataType.STRING(14), allowNull: false })
  declare userCpf: string;

  @Default('member')
  @Column({ type: DataType.STRING(20), allowNull: false })
  declare role: string;

  @BeforeCreate
  static assignId(instance: FamilyMember) {
    if (!instance.id) {
      instance.id = uuidv4();
    }
  }
}
