import fs from "fs";
import path from "path";
import crypto from "crypto";
import { createReadStream } from "fs";
import { createInterface } from "readline";

interface EncryptedBackup {
  version: string;
  iv: string;
  salt: string;
  encryptedData: string;
}

interface ImportedPassword {
  service: string;
  username: string;
  password: string;
  notes?: string;
  tags?: string[];
  createdAt?: string;
  updatedAt?: string;
}

interface PasswordStore {
  [key: string]: ImportedPassword;
}

class ImportCommand {
  private readonly ALGORITHM = "aes-256-cbc";
  private readonly PBKDF2_ITERATIONS = 100000;
  private readonly PBKDF2_DIGEST = "sha256";
  private readonly SALT_LENGTH = 32;
  private readonly IV_LENGTH = 16;
  private passwordStore: PasswordStore = {};
  private storePath: string;

  constructor(storePath: string = path.join(process.cwd(), ".passwords")) {
    this.storePath = storePath;
    this.ensureStorePath();
  }

  private ensureStorePath(): void {
    if (!fs.existsSync(this.storePath)) {
      fs.mkdirSync(this.storePath, { recursive: true, mode: 0o700 });
    }
  }

  private deriveKey(
    masterPassword: string,
    salt: Buffer
  ): { key: Buffer; derivedKey: Buffer } {
    const derivedKey = crypto.pbkdf2Sync(
      masterPassword,
      salt,
      this.PBKDF2_ITERATIONS,
      32,
      this.PBKDF2_DIGEST
    );
    return { key: derivedKey, derivedKey };
  }

  private decryptData(
    encryptedData: string,
    masterPassword: string,
    iv: string,
    salt: string
  ): string {
    try {
      const saltBuffer = Buffer.from(salt, "hex");
      const { derivedKey } = this.deriveKey(masterPassword, saltBuffer);

      const decipher = crypto.createDecipheriv(
        this.ALGORITHM,
        derivedKey,
        Buffer.from(iv, "hex")
      );

      let decrypted = decipher.update(encryptedData, "hex", "utf8");
      decrypted += decipher.final("utf8");

      return decrypted;
    } catch (error) {
      throw new Error(
        `Failed to decrypt data: ${error instanceof Error ? error.message : "Unknown error"}`
      );
    }
  }

  private validateBackupStructure(backup: any): backup is EncryptedBackup {
    return (
      backup &&
      typeof backup === "object" &&
      typeof backup.version === "string" &&
      typeof backup.iv === "string" &&
      typeof backup.salt === "string" &&
      typeof backup.encryptedData === "string"
    );
  }

  private validatePasswordEntry(entry: any): entry is ImportedPassword {
    return (
      entry &&
      typeof entry === "object" &&
      typeof entry.service === "string" &&
      typeof entry.username === "string" &&
      typeof entry.password === "string" &&
      entry.service.trim().length > 0 &&
      entry.username.trim().length > 0 &&
      entry.password.length > 0
    );
  }

  private loadExistingPasswords(): PasswordStore {
    const storePath = path.join(this.storePath, "store.json");
    if (fs.existsSync(storePath)) {
      const data = fs.readFileSync(storePath, "utf8");
      return JSON.parse(data);
    }
    return {};
  }

  private savePasswords(passwords: PasswordStore): void {
    const storePath = path.join(this.storePath, "store.json");
    fs.writeFileSync(storePath, JSON.stringify(passwords, null, 2), {
      mode: 0o600,
    });
  }

  private generateId(service: string, username: string): string {
    return crypto
      .createHash("sha256")
      .update(`${service}:${username}`)
      .digest("hex")
      .substring(0, 16);
  }

  async import(
    backupFilePath: string,
    masterPassword: string,
    options: {
      merge?: boolean;
      overwrite?: boolean;
      validate?: boolean;
    } = {}
  ): Promise<{
    success: boolean;
    imported: number;
    skipped: number;
    errors: Array<{ entry: string; reason: string }>;
  }> {
    const {
      merge = true,
      overwrite = false,
      validate = true,
    } = options;

    const errors: Array<{ entry: string; reason: string }> = [];
    let importedCount = 0;
    let skippedCount = 0;

    try {
      // Validate file exists and is readable
      if (!fs.existsSync(backupFilePath)) {
        throw new Error(`Backup file not found: ${backupFilePath}`);
      }

      const backupContent = fs.readFileSync(backupFilePath, "utf8");
      const backup = JSON.parse(backupContent);

      if (!this.validateBackupStructure(backup)) {
        throw new Error(
          "Invalid backup file structure. Missing required fields: version, iv, salt, encryptedData"
        );
      }

      // Decrypt the backup
      let decryptedData: string;
      try {
        decryptedData = this.decryptData(
          backup.encryptedData,
          masterPassword,
          backup.iv,
          backup.salt
        );
      } catch (error) {
        throw new Error(
          `Decryption failed. Verify the master password is correct: ${error instanceof Error ? error.message : "Unknown error"}`
        );
      }

      // Parse decrypted data
      let importedPasswords: Record<string, ImportedPassword>;
      try {
        importedPasswords = JSON.parse(decryptedData);
        if (!importedPasswords || typeof importedPasswords !== "object") {
          throw new Error("Invalid decrypted data format");
        }
      } catch (error) {
        throw new Error(
          `Failed to parse decrypted backup data: ${error instanceof Error ? error.message : "Unknown error"}`
        );
      }

      // Load existing passwords
      const existingPasswords = merge ? this.loadExistingPasswords() : {};

      // Process each password entry
      for (const [id, entry] of Object.entries(importedPasswords)) {
        try {
          // Validate entry structure if enabled
          if (validate && !this.validatePasswordEntry(entry)) {
            errors.push({
              entry: id,
              reason:
                "Invalid entry structure. Missing required fields: service, username, password",
            });
            skippedCount++;
            continue;
          }

          const entryId = this.generateId(entry.service, entry.username);

          // Check for existing entry
          if (entryId in existingPasswords && !overwrite) {
            errors.push({
              entry: id,
              reason: `Entry for ${entry.service}/${entry.username} already exists`,
            });
            skippedCount++;
            continue;
          }

          // Sanitize entry
          const sanitizedEntry: ImportedPassword = {
            service: entry.service.trim(),
            username: entry.username.trim(),
            password: entry.password,
            notes: entry.notes?.trim() || undefined,
            tags: Array.isArray(entry.tags)
              ? entry.tags.filter((tag: any) => typeof tag === "string")
              : undefined,
            createdAt: entry.createdAt || new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          };

          existingPasswords[entryId] = sanitizedEntry;
          importedCount++;
        } catch (error) {
          errors.push({
            entry: id,
            reason: `Processing error: ${error instanceof Error ? error.message : "Unknown error"}`,
          });
          skippedCount++;
        }
      }

      // Save all passwords
      this.savePasswords(existingPasswords);
      this.passwordStore = existingPasswords;

      return {
        success: errors.length === 0 || importedCount > 0,
        imported: importedCount,
        skipped: skippedCount,
        errors,
      };
    } catch (error) {
      throw new Error(
        `Import failed: ${error instanceof Error ? error.message : "Unknown error"}`
      );
    }
  }

  async importFromString(
    encryptedContent: string,
    masterPassword: string,
    options?: {
      merge?: boolean;
      overwrite?: boolean;
      validate?: boolean;
    }
  ): Promise<{
    success: boolean;
    imported: number;
    skipped: number;
    errors: Array<{ entry: string; reason: string }>;
  }> {
    try {
      const backup = JSON.parse(encryptedContent);

      if (!this.validateBackupStructure(backup)) {
        throw new Error("Invalid backup content structure");
      }

      // Create temporary file
      const tempFile = path.join(
        this.storePath,
        `.temp-${Date.now()}.json`
      );
      fs.writeFileSync(tempFile, encryptedContent, { mode: 0o600 });

      try {
        const result = await this.import(tempFile, masterPassword, options);
        return result;
      } finally {
        // Clean up temporary file
        if (fs.existsSync(tempFile)) {
          fs.unlinkSync(tempFile);
        }
      }
    } catch (error) {
      throw new Error(
        `Import from string failed: ${error instanceof Error ? error.message : "Unknown error"}`
      );
    }
  }

  getImportedPasswords(): PasswordStore {
    return { ...this.passwordStore };
  }

  clearPasswordStore(): void {
    this.passwordStore = {};
  }
}

export default ImportCommand;
export { ImportCommand, ImportedPassword, EncryptedBackup, PasswordStore };