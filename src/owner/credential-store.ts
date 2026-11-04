import { spawn } from 'node:child_process';
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface StoredLogin {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly refreshToken: string;
  readonly createdAt: string;
}

interface StoredFile {
  readonly mode: 'dpapi' | 'file';
  readonly createdAt: string;
  readonly clientId: string;
  /** DPAPI-protected JSON (Windows) or the plain JSON (file mode, readable only by the owner). */
  readonly payload: string;
}

/** The per-user folder for Altimeter's own state; never another program's credential store. */
export function stateDirectory(): string {
  if (process.platform === 'win32') return join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'altimeter');
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support', 'altimeter');
  return join(process.env.XDG_STATE_HOME ?? join(homedir(), '.local', 'state'), 'altimeter');
}

const loginFile = () => join(stateDirectory(), 'search-console-login.json');

/** Runs Windows PowerShell's DPAPI with the secret on stdin, so it never appears in a command line. */
function dpapi(operation: 'protect' | 'unprotect', input: string): Promise<string> {
  const method = operation === 'protect' ? 'Protect' : 'Unprotect';
  const script = [
    'Add-Type -AssemblyName System.Security',
    '$in = [Console]::In.ReadToEnd()',
    operation === 'protect'
      ? `[Convert]::ToBase64String([Security.Cryptography.ProtectedData]::${method}([Text.Encoding]::UTF8.GetBytes($in), $null, 'CurrentUser'))`
      : `[Text.Encoding]::UTF8.GetString([Security.Cryptography.ProtectedData]::${method}([Convert]::FromBase64String($in.Trim()), $null, 'CurrentUser'))`,
  ].join('; ');
  const executable = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  return new Promise((resolve, reject) => {
    const child = spawn(executable, ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
    let output = '';
    child.stdout.on('data', chunk => (output += chunk));
    child.on('error', () => reject(new Error('Windows PowerShell is not available to protect the login.')));
    child.on('close', code => (code === 0 ? resolve(output.trim()) : reject(new Error('The stored login could not be protected or read.'))));
    child.stdin.end(input);
  });
}

/** Keeps the refresh token for later runs: DPAPI on Windows, otherwise only when the owner accepts a private file. */
export async function saveLogin(login: StoredLogin, mode: 'dpapi' | 'file'): Promise<string> {
  if (mode === 'dpapi' && process.platform !== 'win32') throw new Error('Protected storage is only available on Windows here; use --remember=file to keep the login in a private file.');
  const json = JSON.stringify(login);
  const stored: StoredFile = { mode, createdAt: login.createdAt, clientId: login.clientId, payload: mode === 'dpapi' ? await dpapi('protect', json) : json };
  await mkdir(stateDirectory(), { recursive: true, mode: 0o700 });
  await writeFile(loginFile(), `${JSON.stringify(stored)}\n`, { mode: 0o600 });
  if (process.platform !== 'win32') await chmod(loginFile(), 0o600);
  return loginFile();
}

export async function loadLogin(): Promise<StoredLogin | undefined> {
  let stored: StoredFile;
  try {
    stored = JSON.parse(await readFile(loginFile(), 'utf8')) as StoredFile;
  } catch {
    return undefined;
  }
  const json = stored.mode === 'dpapi' ? await dpapi('unprotect', stored.payload) : stored.payload;
  let login: Partial<StoredLogin> | null = null;
  try {
    login = JSON.parse(json) as Partial<StoredLogin> | null;
  } catch {}
  // A fixed message: JSON.parse quotes the text it could not read, and that text holds the secrets.
  if (typeof login?.refreshToken !== 'string' || typeof login.clientId !== 'string' || typeof login.clientSecret !== 'string') throw new Error('The stored login is damaged.');
  return login as StoredLogin;
}

/** Whether a login is stored, without reading its secret. */
export async function loginStatus(): Promise<{ readonly stored: boolean; readonly mode?: string; readonly createdAt?: string }> {
  try {
    const stored = JSON.parse(await readFile(loginFile(), 'utf8')) as StoredFile;
    return { stored: true, mode: stored.mode, createdAt: stored.createdAt };
  } catch {
    return { stored: false };
  }
}

export async function deleteLogin(): Promise<void> {
  await rm(loginFile(), { force: true });
}
