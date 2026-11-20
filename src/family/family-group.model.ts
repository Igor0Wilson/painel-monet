import {
  Table,
  Column,
  Model,
  DataType,
  PrimaryKey,
  Default,
  ForeignKey,
  BelongsTo,
  HasMany,
  BeforeCreate,
} from 'sequelize-typescript';
import { User } from '../users/user.model';
import { FamilyMember } from './family-member.model';
import { randomUUID as uuidv4 } from 'crypto';

@Table({ tableName: 'family_groups', timestamps: true, underscored: true })
export class FamilyGroup extends Model {
  @PrimaryKey
  @Default(uuidv4)
  @Column(DataType.STRING(36))
  declare id: string;

  @Default('Painel Família')
  @Column({ type: DataType.STRING(100), allowNull: false })
  declare name: string;

  @ForeignKey(() => User)
  @Column({ type: DataType.STRING(36), allowNull: false })
  declare createdByUserId: string;

  @BelongsTo(() => User)
  declare createdBy: User;

  @HasMany(() => FamilyMember)
  declare members: FamilyMember[];

  @BeforeCreate
  static assignId(instance: FamilyGroup) {
    if (!instance.id) {
      instance.id = uuidv4();
    }
  }
}
