import {
  Table,
  Column,
  Model,
  DataType,
  PrimaryKey,
  Default,
  Unique,
  HasMany,
  BeforeCreate,
} from 'sequelize-typescript';
import { AccountType } from '../account-types/account-type.model';
import { Expense } from '../expenses/expense.model';
import { Income } from '../income/income.model';
import { randomUUID as uuidv4 } from 'crypto';

@Table({ tableName: 'users', timestamps: true, underscored: true })
export class User extends Model {
  @PrimaryKey
  @Default(uuidv4)
  @Column(DataType.STRING(36))
  declare id: string;

  @Column({ type: DataType.STRING(100), allowNull: false })
  declare name: string;

  @Unique
  @Column({ type: DataType.STRING(150), allowNull: false })
  declare email: string;

  @Column({ type: DataType.STRING(255), allowNull: false })
  declare password: string;

  @Unique
  @Column({ type: DataType.STRING(14), allowNull: true })
  declare cpf: string | null;

  @Column({ type: DataType.STRING(20), allowNull: true })
  declare phone: string | null;

  @HasMany(() => AccountType)
  accountTypes: AccountType[];

  @HasMany(() => Expense)
  expenses: Expense[];

  @HasMany(() => Income)
  incomes: Income[];

  @Default(0)
  @Column({ type: DataType.DECIMAL(10, 2), allowNull: false })
  declare emergencyFund: number;

  @Default(0)
  @Column({ type: DataType.DECIMAL(10, 2), allowNull: false })
  declare investments: number;

  @BeforeCreate
  static assignId(instance: User) {
    if (!instance.id) {
      instance.id = uuidv4();
    }
  }
}
