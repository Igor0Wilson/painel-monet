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

@Table({ tableName: 'income', timestamps: true, underscored: true })
export class Income extends Model {
  @PrimaryKey
  @Default(uuidv4)
  @Column(DataType.STRING(36))
  declare id: string;

  @ForeignKey(() => User)
  @Column(DataType.STRING(36))
  declare userId: string;

  @BelongsTo(() => User)
  user: User;

  @Column({ type: DataType.STRING(150), allowNull: false })
  declare name: string;

  @Column({ type: DataType.DECIMAL(10, 2), allowNull: false })
  declare value: number;

  @Default(false)
  @Column(DataType.BOOLEAN)
  declare isRecurring: boolean;

  @Column({ type: DataType.DATEONLY, allowNull: false })
  declare incomeDate: string;

  @BeforeCreate
  static assignId(instance: Income) {
    if (!instance.id) {
      instance.id = uuidv4();
    }
  }
}
