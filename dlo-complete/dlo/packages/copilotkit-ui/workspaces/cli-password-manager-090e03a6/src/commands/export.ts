import * as fs from 'fs';
import * as path from 'path';
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'crypto';

interface PasswordEntry {
  id: string;
  name: string;
  service: string;
  username: string;
  password: string;
  url?: string;
  notes?: string;
  createdAt: number;
  updatedAt: number;
}

interface ExportBackup {
  version: string;
  timestamp: number;
  salt: string;
  iv: string;
  encryptedData: string;
  authTag: string;
}

const ALGORITHM = 'aes-256-gcm';
const SALT_LENGTH = 32;
const IV_LENGTH = 16;
const ENCRYPTION_VERSION = '1.0.0';
const MIN_PASSWORD_LENGTH = 8;

function deriveKey(masterPassword: string, salt: Buffer): Buffer {
  return scryptSync(masterPassword, salt, 32);
}

function encryptData(
  data: PasswordEntry[],
  masterPassword: string
): Omit<ExportBackup, 'version' | 'timestamp'> {
  const salt = randomBytes(SALT_LENGTH);
  const iv = randomBytes(IV_LENGTH);
  const key = deriveKey(masterPassword, salt);

  const cipher = createCipheriv(ALGORITHM, key, iv);
  const jsonString = JSON.stringify(data);

  let encrypted = cipher.update(jsonString, 'utf8', 'hex');
  encrypted += cipher.final('hex');

  const authTag = cipher.getAuthTag();

  return {
    salt: salt.toString('hex'),
    iv: iv.toString('hex'),
    encryptedData: encrypted,
    authTag: authTag.toString('hex'),
  };
}

function decryptData(backup: ExportBackup, masterPassword: string): PasswordEntry[] {
  const salt = Buffer.from(backup.salt, 'hex');
  const iv = Buffer.from(backup.iv, 'hex');
  const authTag = Buffer.from(backup.authTag, 'hex');
  const key = deriveKey(masterPassword, salt);

  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);

  let decrypted = decipher.update(backup.encryptedData, 'hex', 'utf8');
  decrypted += decipher.final('utf8');

  return JSON.parse(decrypted) as PasswordEntry[];
}

export async function exportVault(
  passwords: PasswordEntry[],
  masterPassword: string,
  outputPath: string,
  options: { pretty?: boolean } = {}
): Promise<{ success: boolean; filePath: string; message: string }> {
  try {
    if (!passwords || passwords.length === 0) {
      throw new Error('No passwords to export');
    }

    if (!masterPassword || masterPassword.length < MIN_PASSWORD_LENGTH) {
      throw new Error(`Master password must be at least ${MIN_PASSWORD_LENGTH} characters`);
    }

    const encryptedFields = encryptData(passwords, masterPassword);

    const backup: ExportBackup = {
      version: ENCRYPTION_VERSION,
      timestamp: Date.now(),
      ...encryptedFields,
    };

    const directory = path.dirname(outputPath);
    if (!fs.existsSync(directory)) {
      fs.mkdirSync(directory, { recursive: true });
    }

    const fileContent = JSON.stringify(backup, null, options.pretty ? 2 : 0);
    fs.writeFileSync(outputPath, fileContent, { mode: 0o600 });

    return {
      success: true,
      filePath: outputPath,
      message: `Successfully exported ${passwords.length} password(s) to ${outputPath}`,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
    return {
      success: false,
      filePath: outputPath,
      message: `Export failed: ${errorMessage}`,
    };
  }
}

export async function importVault(
  backupPath: string,
  masterPassword: string
): Promise<{ success: boolean; passwords: PasswordEntry[]; message: string }> {
  try {
    if (!fs.existsSync(backupPath)) {
      throw new Error(`Backup file not found: ${backupPath}`);
    }

    const fileContent = fs.readFileSync(backupPath, 'utf-8');
    const backup = JSON.parse(fileContent) as ExportBackup;

    if (!backup.version || !backup.salt || !backup.iv || !backup.encryptedData || !backup.authTag) {
      throw new Error('Invalid backup file format');
    }

    if (backup.version !== ENCRYPTION_VERSION) {
      throw new Error(`Unsupported backup version: ${backup.version}`);
    }

    const passwords = decryptData(backup, masterPassword);

    if (!Array.isArray(passwords)) {
      throw new Error('Invalid decrypted data format');
    }

    return {
      success: true,
      passwords,
      message: `Successfully imported ${passwords.length} password(s) from ${backupPath}`,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
    return {
      success: false,
      passwords: [],
      message: `Import failed: ${errorMessage}`,
    };
  }
}

export async function exportCommand(args: {
  inputPath: string;
  outputPath: string;
  masterPassword?: string;
  pretty?: boolean;
}): Promise<void> {
  try {
    if (!fs.existsSync(args.inputPath)) {
      console.error(`Error: Input file not found: ${args.inputPath}`);
      process.exit(1);
    }

    const inputContent = fs.readFileSync(args.inputPath, 'utf-8');
    const passwords = JSON.parse(inputContent) as PasswordEntry[];

    const masterPassword = args.masterPassword || process.env.MASTER_PASSWORD;
    if (!masterPassword) {
      console.error('Error: Master password required (set MASTER_PASSWORD env var or pass --password)');
      process.exit(1);
    }

    const result = await exportVault(passwords, masterPassword, args.outputPath, {
      pretty: args.pretty ?? true,
    });

    if (result.success) {
      console.log(`✓ ${result.message}`);
    } else {
      console.error(`✗ ${result.message}`);
      process.exit(1);
    }
  } catch (error) {
    console.error(`Fatal error: ${error instanceof Error ? error.message : 'Unknown error'}`);
    process.exit(1);
  }
}

export async function importCommand(args: {
  backupPath: string;
  outputPath: string;
  masterPassword?: string;
}): Promise<void> {
  try {
    const masterPassword = args.masterPassword || process.env.MASTER_PASSWORD;
    if (!masterPassword) {
      console.error('Error: Master password required (set MASTER_PASSWORD env var or pass --password)');
      process.exit(1);
    }

    const result = await importVault(args.backupPath, masterPassword);

    if (result.success) {
      const outputDir = path.dirname(args.outputPath);
      if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
      }

      fs.writeFileSync(args.outputPath, JSON.stringify(result.passwords, null, 2), {
        mode: 0o600,
      });

      console.log(`✓ ${result.message}`);
      console.log(`✓ Imported passwords written to ${args.outputPath}`);
    } else {
      console.error(`✗ ${result.message}`);
      process.exit(1);
    }
  } catch (error) {
    console.error(`Fatal error: ${error instanceof Error ? error.message : 'Unknown error'}`);
    process.exit(1);
  }
}