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
import { AccountType } from '../account-types/account-type.model';
import { randomUUID as uuidv4 } from 'crypto';

@Table({ tableName: 'expenses', timestamps: true, underscored: true })
export class Expense extends Model {
  @PrimaryKey
  @Default(uuidv4)
  @Column(DataType.STRING(36))
  declare id: string;

  @ForeignKey(() => User)
  @Column(DataType.STRING(36))
  declare userId: string;

  @BelongsTo(() => User)
  user: User;

  @ForeignKey(() => AccountType)
  @Column(DataType.STRING(36))
  declare accountTypeId: string;

  @BelongsTo(() => AccountType)
  accountType: AccountType;

  @Column({ type: DataType.STRING(150), allowNull: false })
  declare name: string;

  @Column({ type: DataType.DECIMAL(10, 2), allowNull: false })
  declare value: number;

  @Column({ type: DataType.DATEONLY, allowNull: false })
  declare dueDate: string;

  @Default(false)
  @Column(DataType.BOOLEAN)
  declare isRecurring: boolean;

  @Default(false)
  @Column(DataType.BOOLEAN)
  declare isInstallment: boolean;

  @Column({ type: DataType.INTEGER, allowNull: true })
  declare installmentCount: number | null;

  @Column({ type: DataType.INTEGER, allowNull: true })
  declare installmentNumber: number | null;

  @ForeignKey(() => Expense)
  @Column({ type: DataType.STRING(36), allowNull: true })
  declare parentExpenseId: string | null;

  @Default(false)
  @Column(DataType.BOOLEAN)
  declare isPaid: boolean;

  @Default(false)
  @Column(DataType.BOOLEAN)
  declare isCreditCard: boolean;

  @Column({ type: DataType.STRING(20), allowNull: true })
  declare paymentMethod: string | null;

  @BeforeCreate
  static assignId(instance: Expense) {
    if (!instance.id) {
      instance.id = uuidv4();
    }
  }
}
