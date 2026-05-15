import path from 'node:path';
import fs from 'node:fs';
import { simpleGit, type SimpleGit } from 'simple-git';

/**
 * content_git is a sibling repo whose working tree is the `content/` directory.
 * We initialize it the first time it's missing, then make commits manually.
 */
export class ContentGit {
  private git: SimpleGit;
  private contentDir: string;
  constructor(dataDir: string) {
    const gitDir = path.join(dataDir, 'content_git');
    this.contentDir = path.join(dataDir, 'content');
    if (!fs.existsSync(this.contentDir)) fs.mkdirSync(this.contentDir, { recursive: true });
    if (!fs.existsSync(gitDir)) fs.mkdirSync(gitDir, { recursive: true });
    // Use --separate-git-dir so .git lives in content_git/ but tree is content/
    this.git = simpleGit(this.contentDir);
    if (!fs.existsSync(path.join(gitDir, 'HEAD'))) {
      // initialize
      this.git
        .init(['--separate-git-dir', gitDir])
        .then(() => this.git.addConfig('user.email', 'kb@local'))
        .then(() => this.git.addConfig('user.name', 'KB'))
        .catch(() => undefined);
    }
  }

  async commitFile(relativePath: string, message: string): Promise<void> {
    try {
      await this.git.add([relativePath]);
      await this.git.commit(message, [relativePath], { '--allow-empty': null });
    } catch {
      // first commit on empty repo may need different handling; ignore non-fatal errors
    }
  }

  async log(relativePath: string): Promise<{ hash: string; message: string; date: string }[]> {
    try {
      const res = await this.git.log({ file: relativePath });
      return res.all.map((l) => ({ hash: l.hash, message: l.message, date: l.date }));
    } catch {
      return [];
    }
  }
}
