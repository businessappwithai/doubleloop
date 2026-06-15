import crypto from 'crypto';
import { Database } from 'better-sqlite3';

// Encryption configuration
export const ENCRYPTION_ALGORITHM = 'aes-256-gcm';
export const SALT_LENGTH = 32;
export const TAG_LENGTH = 16;
export const IV_LENGTH = 16;
export const KEY_LENGTH = 32;

// Password model interface
export interface PasswordEntry {
  id: string;
  name: string;
  service: string;
  username: string;
  password: string;
  url?: string;
  notes?: string;
  tags: string[];
  createdAt: number;
  updatedAt: number;
  lastAccessedAt?: number;
}

// Database storage interface
export interface StoredPasswordEntry {
  id: string;
  name: string;
  service: string;
  username: string;
  encryptedPassword: string;
  iv: string;
  authTag: string;
  url?: string;
  notes?: string;
  tags: string;
  createdAt: number;
  updatedAt: number;
  lastAccessedAt?: number;
}

// Master password hash interface
export interface MasterPasswordHash {
  hash: string;
  salt: string;
  algorithm: string;
  iterations: number;
}

// Encryption result interface
export interface EncryptionResult {
  encryptedData: string;
  iv: string;
  authTag: string;
}

// Search result interface
export interface SearchResult {
  entries: PasswordEntry[];
  count: number;
  query: string;
}

// Export format interface
export interface ExportData {
  version: string;
  exportedAt: number;
  entries: StoredPasswordEntry[];
  encryptionAlgorithm: string;
}

// Import validation result
export interface ImportValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
  entryCount: number;
}

/**
 * Encryption utility class for AES-256-GCM encryption/decryption
 */
export class EncryptionUtility {
  /**
   * Derive encryption key from master password
   */
  static deriveKey(masterPassword: string, salt?: Buffer): { key: Buffer; salt: Buffer } {
    const saltBuffer = salt || crypto.randomBytes(SALT_LENGTH);
    const key = crypto.pbkdf2Sync(masterPassword, saltBuffer, 100000, KEY_LENGTH, 'sha256');
    return { key, salt: saltBuffer };
  }

  /**
   * Encrypt password data
   */
  static encrypt(data: string, masterPassword: string, salt?: Buffer): EncryptionResult {
    const { key, salt: usedSalt } = this.deriveKey(masterPassword, salt);
    const iv = crypto.randomBytes(IV_LENGTH);

    const cipher = crypto.createCipheriv(ENCRYPTION_ALGORITHM, key, iv);
    let encryptedData = cipher.update(data, 'utf8', 'hex');
    encryptedData += cipher.final('hex');

    const authTag = cipher.getAuthTag();

    return {
      encryptedData,
      iv: iv.toString('hex'),
      authTag: authTag.toString('hex'),
    };
  }

  /**
   * Decrypt password data
   */
  static decrypt(encrypted: string, iv: string, authTag: string, masterPassword: string, salt: Buffer): string {
    const { key } = this.deriveKey(masterPassword, salt);
    const decipher = crypto.createDecipheriv(ENCRYPTION_ALGORITHM, key, Buffer.from(iv, 'hex'));

    decipher.setAuthTag(Buffer.from(authTag, 'hex'));

    let decrypted = decipher.update(encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');

    return decrypted;
  }

  /**
   * Hash master password for storage
   */
  static hashMasterPassword(masterPassword: string): MasterPasswordHash {
    const salt = crypto.randomBytes(SALT_LENGTH);
    const hash = crypto.pbkdf2Sync(masterPassword, salt, 100000, KEY_LENGTH, 'sha256');

    return {
      hash: hash.toString('hex'),
      salt: salt.toString('hex'),
      algorithm: 'pbkdf2',
      iterations: 100000,
    };
  }

  /**
   * Verify master password against stored hash
   */
  static verifyMasterPassword(masterPassword: string, storedHash: MasterPasswordHash): boolean {
    const computedHash = crypto.pbkdf2Sync(
      masterPassword,
      Buffer.from(storedHash.salt, 'hex'),
      storedHash.iterations,
      KEY_LENGTH,
      'sha256'
    );

    return crypto.timingSafeEqual(Buffer.from(storedHash.hash, 'hex'), computedHash);
  }
}

/**
 * Password database model class
 */
export class PasswordModel {
  private db: Database;
  private salt: Buffer;

  constructor(db: Database, salt: Buffer) {
    this.db = db;
    this.salt = salt;
    this.initializeSchema();
  }

  /**
   * Initialize database schema
   */
  private initializeSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS passwords (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        service TEXT NOT NULL,
        username TEXT NOT NULL,
        encryptedPassword TEXT NOT NULL,
        iv TEXT NOT NULL,
        authTag TEXT NOT NULL,
        url TEXT,
        notes TEXT,
        tags TEXT DEFAULT '[]',
        createdAt INTEGER NOT NULL,
        updatedAt INTEGER NOT NULL,
        lastAccessedAt INTEGER,
        UNIQUE(service, username)
      );

      CREATE INDEX IF NOT EXISTS idx_service ON passwords(service);
      CREATE INDEX IF NOT EXISTS idx_name ON passwords(name);
      CREATE INDEX IF NOT EXISTS idx_tags ON passwords(tags);
    `);
  }

  /**
   * Create a new password entry
   */
  create(entry: Omit<PasswordEntry, 'id' | 'createdAt' | 'updatedAt'>, masterPassword: string): PasswordEntry {
    const id = crypto.randomUUID();
    const now = Date.now();

    const encrypted = EncryptionUtility.encrypt(entry.password, masterPassword, this.salt);

    const stmt = this.db.prepare(`
      INSERT INTO passwords (id, name, service, username, encryptedPassword, iv, authTag, url, notes, tags, createdAt, updatedAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      id,
      entry.name,
      entry.service,
      entry.username,
      encrypted.encryptedData,
      encrypted.iv,
      encrypted.authTag,
      entry.url || null,
      entry.notes || null,
      JSON.stringify(entry.tags),
      now,
      now
    );

    return {
      id,
      ...entry,
      createdAt: now,
      updatedAt: now,
    };
  }

  /**
   * Retrieve a password entry by ID
   */
  getById(id: string, masterPassword: string): PasswordEntry | null {
    const stmt = this.db.prepare('SELECT * FROM passwords WHERE id = ?');
    const row = stmt.get(id) as StoredPasswordEntry | undefined;

    if (!row) return null;

    const decrypted = EncryptionUtility.decrypt(
      row.encryptedPassword,
      row.iv,
      row.authTag,
      masterPassword,
      this.salt
    );

    return this.mapToPasswordEntry(row, decrypted);
  }

  /**
   * Search passwords by name or service
   */
  search(query: string, masterPassword: string): SearchResult {
    const searchTerm = `%${query.toLowerCase()}%`;
    const stmt = this.db.prepare(`
      SELECT * FROM passwords
      WHERE LOWER(name) LIKE ? OR LOWER(service) LIKE ? OR LOWER(username) LIKE ?
      ORDER BY updatedAt DESC
    `);

    const rows = stmt.all(searchTerm, searchTerm, searchTerm) as StoredPasswordEntry[];

    const entries = rows.map((row) => {
      const decrypted = EncryptionUtility.decrypt(
        row.encryptedPassword,
        row.iv,
        row.authTag,
        masterPassword,
        this.salt
      );
      return this.mapToPasswordEntry(row, decrypted);
    });

    return {
      entries,
      count: entries.length,
      query,
    };
  }

  /**
   * Get all passwords
   */
  getAll(masterPassword: string): PasswordEntry[] {
    const stmt = this.db.prepare('SELECT * FROM passwords ORDER BY updatedAt DESC');
    const rows = stmt.all() as StoredPasswordEntry[];

    return rows.map((row) => {
      const decrypted = EncryptionUtility.decrypt(
        row.encryptedPassword,
        row.iv,
        row.authTag,
        masterPassword,
        this.salt
      );
      return this.mapToPasswordEntry(row, decrypted);
    });
  }

  /**
   * Update a password entry
   */
  update(id: string, updates: Partial<Omit<PasswordEntry, 'id' | 'createdAt' | 'updatedAt'>>, masterPassword: string): PasswordEntry {
    const existing = this.getById(id, masterPassword);
    if (!existing) throw new Error(`Password entry with id ${id} not found`);

    const updated = { ...existing, ...updates };
    const now = Date.now();

    const encrypted = EncryptionUtility.encrypt(updated.password, masterPassword, this.salt);

    const stmt = this.db.prepare(`
      UPDATE passwords
      SET name = ?, service = ?, username = ?, encryptedPassword = ?, iv = ?, authTag = ?, url = ?, notes = ?, tags = ?, updatedAt = ?
      WHERE id = ?
    `);

    stmt.run(
      updated.name,
      updated.service,
      updated.username,
      encrypted.encryptedData,
      encrypted.iv,
      encrypted.authTag,
      updated.url || null,
      updated.notes || null,
      JSON.stringify(updated.tags),
      now,
      id
    );

    return {
      ...updated,
      updatedAt: now,
    };
  }

  /**
   * Delete a password entry
   */
  delete(id: string): boolean {
    const stmt = this.db.prepare('DELETE FROM passwords WHERE id = ?');
    const result = stmt.run(id);
    return result.changes > 0;
  }

  /**
   * Get entries by tag
   */
  getByTag(tag: string, masterPassword: string): PasswordEntry[] {
    const stmt = this.db.prepare(`
      SELECT * FROM passwords
      WHERE tags LIKE ?
      ORDER BY updatedAt DESC
    `);

    const rows = stmt.all(`%"${tag}"%`) as StoredPasswordEntry[];

    return rows.map((row) => {
      const decrypted = EncryptionUtility.decrypt(
        row.encryptedPassword,
        row.iv,
        row.authTag,
        masterPassword,
        this.salt
      );
      return this.mapToPasswordEntry(row, decrypted);
    });
  }

  /**
   * Export all passwords
   */
  exportAll(masterPassword: string): ExportData {
    const stmt = this.db.prepare('SELECT * FROM passwords');
    const rows = stmt.all() as StoredPasswordEntry[];

    return {
      version: '1.0',
      exportedAt: Date.now(),
      entries: rows,
      encryptionAlgorithm: ENCRYPTION_ALGORITHM,
    };
  }

  /**
   * Validate import data
   */
  validateImportData(data: ExportData): ImportValidationResult {
    const errors: string[] = [];
    const warnings: string[] = [];

    if (!data.version) errors.push('Missing version field');
    if (!Array.isArray(data.entries)) errors.push('Entries must be an array');
    if (data.encryptionAlgorithm !== ENCRYPTION_ALGORITHM) {
      warnings.push(`Encryption algorithm mismatch: expected ${ENCRYPTION_ALGORITHM}, got ${data.encryptionAlgorithm}`);
    }

    if (Array.isArray(data.entries)) {
      const uniqueKey = new Set<string>();
      data.entries.forEach((entry, index) => {
        if (!entry.id) errors.push(`Entry ${index}: missing id`);
        if (!entry.name) errors.push(`Entry ${index}: missing name`);
        if (!entry.service) errors.push(`Entry ${index}: missing service`);
        if (!entry.username) errors.push(`Entry ${index}: missing username`);
        if (!entry.encryptedPassword) errors.push(`Entry ${index}: missing encryptedPassword`);

        const key = `${entry.service}:${entry.username}`;
        if (uniqueKey.has(key)) warnings.push(`Entry ${index}: duplicate service/username combination`);
        uniqueKey.add(key);
      });
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings,
      entryCount: Array.isArray(data.entries) ? data.entries.length : 0,
    };
  }

  /**
   * Map stored database row to PasswordEntry
   */
  private mapToPasswordEntry(row: StoredPasswordEntry, decryptedPassword: string): PasswordEntry {
    return {
      id: row.id,
      name: row.name,
      service: row.service,
      username: row.username,
      password: decryptedPassword,
      url: row.url,
      notes: row.notes,
      tags: JSON.parse(row.tags || '[]'),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      lastAccessedAt: row.lastAccessedAt,
    };
  }

  /**
   * Get database statistics
   */
  getStats(): { totalEntries: number; totalServices: number; oldestEntry: number; newestEntry: number } {
    const countStmt = this.db.prepare('SELECT COUNT(*) as count FROM passwords');
    const servicesStmt = this.db.prepare('SELECT COUNT(DISTINCT service) as count FROM passwords');
    const datesStmt = this.db.prepare('SELECT MIN(createdAt) as oldest, MAX(createdAt) as newest FROM passwords');

    const countResult = countStmt.get() as { count: number };
    const servicesResult = servicesStmt.get() as { count: number };
    const datesResult = datesStmt.get() as { oldest: number; newest: number };

    return {
      totalEntries: countResult.count,
      totalServices: servicesResult.count,
      oldestEntry: datesResult.oldest || 0,
      newestEntry: datesResult.newest || 0,
    };
  }

  /**
   * Clear all passwords (dangerous operation)
   */
  deleteAll(): number {
    const stmt = this.db.prepare('DELETE FROM passwords');
    const result = stmt.run();
    return result.changes;
  }
}