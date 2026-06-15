import crypto from 'crypto';

interface EncryptionResult {
  ciphertext: string;
  iv: string;
  authTag: string;
  salt: string;
}

interface DecryptionParams {
  ciphertext: string;
  iv: string;
  authTag: string;
  salt: string;
}

export class PasswordEncryption {
  private static readonly ALGORITHM = 'aes-256-gcm';
  private static readonly SALT_LENGTH = 16;
  private static readonly IV_LENGTH = 16;
  private static readonly TAG_LENGTH = 16;
  private static readonly KEY_LENGTH = 32;
  private static readonly ITERATIONS = 100000;
  private static readonly DIGEST = 'sha256';

  static deriveMasterKey(masterPassword: string, salt?: Buffer): { key: Buffer; salt: Buffer } {
    const derivedSalt = salt || crypto.randomBytes(this.SALT_LENGTH);

    const key = crypto.pbkdf2Sync(
      masterPassword,
      derivedSalt,
      this.ITERATIONS,
      this.KEY_LENGTH,
      this.DIGEST
    );

    return { key, salt: derivedSalt };
  }

  static encrypt(plaintext: string, masterPassword: string): EncryptionResult {
    const { key, salt } = this.deriveMasterKey(masterPassword);
    const iv = crypto.randomBytes(this.IV_LENGTH);

    const cipher = crypto.createCipheriv(this.ALGORITHM, key, iv);
    let encrypted = cipher.update(plaintext, 'utf8', 'hex');
    encrypted += cipher.final('hex');

    const authTag = cipher.getAuthTag();

    return {
      ciphertext: encrypted,
      iv: iv.toString('hex'),
      authTag: authTag.toString('hex'),
      salt: salt.toString('hex'),
    };
  }

  static decrypt(params: DecryptionParams, masterPassword: string): string {
    const salt = Buffer.from(params.salt, 'hex');
    const { key } = this.deriveMasterKey(masterPassword, salt);
    const iv = Buffer.from(params.iv, 'hex');
    const authTag = Buffer.from(params.authTag, 'hex');

    const decipher = crypto.createDecipheriv(this.ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);

    let decrypted = decipher.update(params.ciphertext, 'hex', 'utf8');
    decrypted += decipher.final('utf8');

    return decrypted;
  }

  static validateMasterPassword(
    inputPassword: string,
    storedHash: string,
    salt: string
  ): boolean {
    const { key } = this.deriveMasterKey(inputPassword, Buffer.from(salt, 'hex'));
    return crypto.timingSafeEqual(key, Buffer.from(storedHash, 'hex'));
  }

  static hashMasterPassword(masterPassword: string): { hash: string; salt: string } {
    const { key, salt } = this.deriveMasterKey(masterPassword);
    return {
      hash: key.toString('hex'),
      salt: salt.toString('hex'),
    };
  }

  static generatePassword(length: number = 16): string {
    const charset = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%^&*()_+-=[]{}|;:,.<>?';
    const bytes = crypto.randomBytes(length);
    let password = '';

    for (let i = 0; i < length; i++) {
      password += charset[bytes[i] % charset.length];
    }

    return password;
  }

  static encryptToBase64(plaintext: string, masterPassword: string): string {
    const encrypted = this.encrypt(plaintext, masterPassword);
    const payload = JSON.stringify(encrypted);
    return Buffer.from(payload).toString('base64');
  }

  static decryptFromBase64(encoded: string, masterPassword: string): string {
    const payload = Buffer.from(encoded, 'base64').toString('utf8');
    const params = JSON.parse(payload) as DecryptionParams;
    return this.decrypt(params, masterPassword);
  }
}

export default PasswordEncryption;