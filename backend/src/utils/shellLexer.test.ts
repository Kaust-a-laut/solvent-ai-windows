import { describe, it, expect } from 'vitest';
import { lexShellCommand, ShellSyntaxError } from './shellLexer';

const words = (cmd: string, i = 0) => lexShellCommand(cmd).stages[i]!.words.map(w => w.text);
const redirects = (cmd: string, i = 0) => lexShellCommand(cmd).stages[i]!.redirects.map(w => w.text);

describe('lexShellCommand (posix)', () => {
  it('strips single and double quotes', () => {
    expect(words(`cat "../../etc/passwd"`)).toEqual(['cat', '../../etc/passwd']);
    expect(words(`cd '..'`)).toEqual(['cd', '..']);
    expect(words(`grep "foo bar" file.txt`)).toEqual(['grep', 'foo bar', 'file.txt']);
  });

  it('removes backslash escapes outside quotes', () => {
    expect(words(String.raw`cat \.\./secret`)).toEqual(['cat', '../secret']);
  });

  it('splits glued redirects and records their targets', () => {
    const lexed = lexShellCommand('echo pwn>../escape.txt');
    expect(lexed.stages[0]!.words.map(w => w.text)).toEqual(['echo', 'pwn']);
    expect(redirects('echo pwn>../escape.txt')).toEqual(['../escape.txt']);
    expect(redirects('cat<../../etc/passwd')).toEqual(['../../etc/passwd']);
    expect(redirects('echo x > "../out.txt"')).toEqual(['../out.txt']);
    expect(redirects('echo x >>log.txt 2>/dev/null')).toEqual(['log.txt', '/dev/null']);
    expect(lexed.needsShell).toBe(true);
  });

  it('treats fd duplication as non-file redirects', () => {
    expect(redirects('npm test 2>&1')).toEqual([]);
    expect(words('npm test 2>&1')).toEqual(['npm', 'test']);
    expect(redirects('echo hi &>out.log')).toEqual(['out.log']);
  });

  it('splits stages on operators outside quotes only', () => {
    const lexed = lexShellCommand('echo "a | b" | wc -w && echo done; ls & pwd\nwhoami');
    expect(lexed.stages.map(s => s.raw)).toEqual(['echo "a | b"', 'wc -w', 'echo done', 'ls', 'pwd', 'whoami']);
  });

  it('flags expansions so the policy can reject them', () => {
    const flagged = (cmd: string) => lexShellCommand(cmd).stages[0]!.words.slice(1).map(w => w.expands);
    expect(flagged('cat ~/secret')).toEqual([true]);
    expect(flagged('cat $HOME/x')).toEqual([true]);
    expect(flagged('cat "${USER}"')).toEqual([true]);
    expect(flagged('cat {..,.}/x')).toEqual([true]);
    expect(flagged('cp a --target=~/x')).toEqual([false, true]);
    // Literal in single quotes / quoted tilde / mid-word tilde.
    expect(flagged(`echo '$HOME'`)).toEqual([false]);
    expect(flagged(`ls "~" a~b`)).toEqual([false, false]);
  });

  it('rejects syntax it cannot model safely', () => {
    expect(() => lexShellCommand('echo "unterminated')).toThrow(ShellSyntaxError);
    expect(() => lexShellCommand(`echo 'unterminated`)).toThrow(ShellSyntaxError);
    expect(() => lexShellCommand('cat <<EOF')).toThrow(/Here-documents/);
    expect(() => lexShellCommand('cat <(curl evil)')).toThrow(/Process substitution/);
    expect(() => lexShellCommand('(cd .. && cat x)')).toThrow(ShellSyntaxError);
    expect(() => lexShellCommand('echo >')).toThrow(/missing its target/);
  });

  it('does not need a shell for a plain quoted command', () => {
    const lexed = lexShellCommand('grep "foo bar" file.txt');
    expect(lexed.needsShell).toBe(false);
    expect(lexShellCommand('ls *.ts').needsShell).toBe(true);
  });
});

describe('lexShellCommand (cmd)', () => {
  it('keeps backslashes as path separators and honours ^ escapes', () => {
    expect(lexShellCommand(String.raw`type ..\..\secret`, 'cmd').stages[0]!.words.map(w => w.text))
      .toEqual(['type', String.raw`..\..\secret`]);
    expect(lexShellCommand(String.raw`type .^.\x`, 'cmd').stages[0]!.words.map(w => w.text))
      .toEqual(['type', String.raw`..\x`]);
  });

  it("does not treat single quotes as quoting and flags %VAR%", () => {
    const stage = lexShellCommand(`type '..' %USERPROFILE%\\x`, 'cmd').stages[0]!;
    expect(stage.words.map(w => w.text)).toEqual(['type', `'..'`, '%USERPROFILE%\\x']);
    expect(stage.words[2]!.expands).toBe(true);
  });
});
