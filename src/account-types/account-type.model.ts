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
import { randomUUID as uuidv4 } from 'crypto';

@Table({ tableName: 'account_types', timestamps: true, underscored: true })
export class AccountType extends Model {
  @PrimaryKey
  @Default(uuidv4)
  @Column(DataType.STRING(36))
  declare id: string;

  @Column({ type: DataType.STRING(100), allowNull: false })
  declare name: string;

  @ForeignKey(() => User)
  @Column(DataType.STRING(36))
  declare userId: string;

  @BelongsTo(() => User)
  user: User;

  @BeforeCreate
  static assignId(instance: AccountType) {
    if (!instance.id) {
      instance.id = uuidv4();
    }
  }
}
