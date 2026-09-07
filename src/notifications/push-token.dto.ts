import { IsIn, IsOptional, IsString } from 'class-validator';

export class RegisterPushTokenDto {
  /** Expo push token, e.g. ExponentPushToken[xxxxxxxxxxxxxxxx]. */
  @IsString()
  token!: string;

  @IsOptional()
  @IsIn(['ios', 'android'])
  platform?: 'ios' | 'android';
}
