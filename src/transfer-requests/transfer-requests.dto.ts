import { IsString } from 'class-validator';

export class CreateTransferRequestDto {
  @IsString() memberId!: string;
}

export class AdminCreateTransferRequestDto {
  @IsString() memberId!: string;
  @IsString() toGymId!: string;
}
