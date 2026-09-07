import { IsEmail, IsIn, IsOptional, IsString, MinLength } from 'class-validator';

export class CreateAdminDto {
  @IsString() name!: string;
  @IsEmail() email!: string;
  @IsString() @MinLength(8) password!: string;
  @IsOptional() @IsIn(['super_admin', 'support']) role?: 'super_admin' | 'support';
}
