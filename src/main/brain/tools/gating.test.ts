import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { fakeContext } from './fakes.test'
import { DENIED_MESSAGE, defineTool, errorMessage, isCatastrophic, shorten, truncateText, wrapTool } from './gating'

describe('isCatastrophic', () => {
  it.each([
    'Format-Volume -DriveLetter C',
    'format c: /q',
    'diskpart /s script.txt',
    'bcdedit /set {default} safeboot minimal',
    'cipher /w:C:\\',
    'Stop-Computer -Force',
    'Restart-Computer',
    'shutdown /s /t 0',
    'shutdown -r',
    'reg delete HKLM\\SOFTWARE\\Foo /f',
    'reg.exe delete "HKEY_LOCAL_MACHINE\\SYSTEM\\x"',
    "Remove-Item -Path 'HKLM:\\SOFTWARE\\Foo' -Recurse",
    'vssadmin delete shadows /all /quiet',
    'Remove-Item C:\\ -Recurse -Force',
    'Remove-Item -Recurse -Force "C:\\"',
    'rm -r C:\\*',
    'rm -rf ~',
    'del /s /q C:\\Windows\\*',
    'rd /s /q C:\\Windows',
    'Remove-Item $env:SystemRoot -Recurse',
    "Remove-Item -LiteralPath 'C:\\Program Files' -Recurse",
    'Remove-Item $env:USERPROFILE -Recurse -Force',
    'Get-ChildItem C:\\ -Recurse | Remove-Item -Force',
    'Write-Host hi; Remove-Item D:\\ -Recurse',
    'Clear-Disk -Number 0 -RemoveData',
    'Remove-Item C:\\Windows\\System32 -Recurse',
  ])('flags %s', (script) => {
    expect(isCatastrophic(script)).toBe(true)
  })

  it.each([
    'Get-Process | Select-Object -First 5',
    'Remove-Item C:\\Users\\max\\Downloads\\tmp -Recurse',
    'Remove-Item ~/Downloads/old -Recurse -Force',
    'Remove-Item C:\\Temp\\build -Recurse',
    'rm -r ./dist',
    'Remove-Item C:\\Windows\\Temp\\x.log',
    'Get-ChildItem C:\\ | Where-Object Name -like "*.txt"',
    'Format-Table -AutoSize',
    'Get-Item HKLM:\\SOFTWARE\\Microsoft',
    'shutdown /a',
    'winget install --id Mozilla.Firefox',
    'Remove-Item $env:TEMP\\flowy -Recurse',
    'Get-ChildItem "C:\\Program Files" -Recurse -Filter *.exe',
    '',
  ])('allows %s', (script) => {
    expect(isCatastrophic(script)).toBe(false)
  })

  it('is case- and whitespace-insensitive', () => {
    expect(isCatastrophic('  STOP-computer')).toBe(true)
    expect(isCatastrophic('remove-item\t-recurse   "c:\\"')).toBe(true)
  })
})

describe('helpers', () => {
  it('truncateText adds a tail marker only when needed', () => {
    expect(truncateText('abc', 10)).toBe('abc')
    expect(truncateText('abcdef', 3)).toBe('abc\n…[gekürzt, 3 Zeichen ausgelassen]')
  })

  it('shorten collapses whitespace and cuts with an ellipsis', () => {
    expect(shorten('  a   b\n c ')).toBe('a b c')
    expect(shorten('x'.repeat(100), 10)).toBe('xxxxxxxxx…')
  })

  it('errorMessage maps Node fs codes to German', () => {
    expect(errorMessage(Object.assign(new Error('x'), { code: 'ENOENT', path: 'C:\\x' }))).toBe('Datei oder Ordner nicht gefunden: C:\\x')
    expect(errorMessage(Object.assign(new Error('x'), { code: 'EACCES' }))).toBe('Zugriff verweigert')
    expect(errorMessage(new Error('plain'))).toBe('plain')
    expect(errorMessage(Object.assign(new Error('t'), { name: 'TimeoutError' }))).toBe('Zeitüberschreitung')
    expect(errorMessage('str')).toBe('str')
  })
})

function sampleTool(options: { destructive?: boolean; readOnly?: boolean; category?: 'shell' | 'files' | 'misc'; fail?: boolean } = {}) {
  const execute = vi.fn(async (input: { script: string }) => {
    if (options.fail) throw new Error('kaputt')
    return { content: `ran ${input.script}` }
  })
  const tool = defineTool({
    name: 'sample',
    description: 'sample',
    category: options.category ?? 'shell',
    destructive: options.destructive ?? true,
    readOnly: options.readOnly ?? false,
    inputSchema: z.object({ script: z.string() }),
    summarize: (input) => `Sample: ${input.script}`,
    scriptOf: (input) => input.script,
    execute,
  })
  return { tool, execute, wrapped: wrapTool(tool) }
}

describe('wrapTool', () => {
  it('runs without prompting at level full', async () => {
    const { wrapped, execute } = sampleTool()
    const ctx = fakeContext({ permissions: { level: 'full' } })
    const result = await wrapped.execute({ script: 'Get-Date' }, ctx)
    expect(result).toEqual({ content: 'ran Get-Date' })
    expect(ctx.confirm).not.toHaveBeenCalled()
    expect(execute).toHaveBeenCalledTimes(1)
  })

  it('asks for confirmation for destructive tools at confirm-destructive and reports a denial', async () => {
    const { wrapped, execute } = sampleTool()
    const denied = fakeContext({ permissions: { level: 'confirm-destructive' } }, { approve: false })
    expect(await wrapped.execute({ script: 'x' }, denied)).toEqual({ isError: true, content: DENIED_MESSAGE })
    expect(execute).not.toHaveBeenCalled()
    expect(denied.confirm).toHaveBeenCalledWith(expect.objectContaining({ danger: true, title: 'Aktion bestätigen', detail: 'Sample: x' }))

    const approved = fakeContext({ permissions: { level: 'confirm-destructive' } }, { approve: true })
    expect(await wrapped.execute({ script: 'x' }, approved)).toEqual({ content: 'ran x' })
  })

  it('does not prompt for non-destructive tools at confirm-destructive', async () => {
    const { wrapped } = sampleTool({ destructive: false })
    const ctx = fakeContext({ permissions: { level: 'confirm-destructive' } })
    await wrapped.execute({ script: 'x' }, ctx)
    expect(ctx.confirm).not.toHaveBeenCalled()
  })

  it('still asks for catastrophic scripts at level full', async () => {
    const { wrapped, execute } = sampleTool()
    const ctx = fakeContext({ permissions: { level: 'full' } }, { approve: false })
    const result = await wrapped.execute({ script: 'Remove-Item C:\\ -Recurse -Force' }, ctx)
    expect(result).toEqual({ isError: true, content: DENIED_MESSAGE })
    expect(ctx.confirm).toHaveBeenCalledWith(expect.objectContaining({ title: 'Gefährlichen Befehl bestätigen', danger: true }))
    expect(execute).not.toHaveBeenCalled()
  })

  it('refuses non-readOnly tools at read-only without calling execute', async () => {
    const { wrapped, execute } = sampleTool({ destructive: false, readOnly: false })
    const ctx = fakeContext({ permissions: { level: 'read-only' } })
    const result = await wrapped.execute({ script: 'x' }, ctx)
    expect(result.isError).toBe(true)
    expect(result.content).toContain('Nur-Lese-Modus')
    expect(execute).not.toHaveBeenCalled()
  })

  it('refuses tools whose category flag is off', async () => {
    const { wrapped } = sampleTool({ category: 'files', destructive: false, readOnly: true })
    const ctx = fakeContext({ permissions: { allowFiles: false } })
    const result = await wrapped.execute({ script: 'x' }, ctx)
    expect(result.isError).toBe(true)
    expect(result.content).toContain('deaktiviert')
  })

  it('turns thrown errors into readable error results', async () => {
    const { wrapped } = sampleTool({ fail: true })
    const result = await wrapped.execute({ script: 'x' }, fakeContext())
    expect(result).toEqual({ isError: true, content: 'kaputt' })
  })

  it('keeps the public ToolDefinition shape', () => {
    const { wrapped } = sampleTool()
    expect(wrapped.name).toBe('sample')
    expect(wrapped.summarize?.({ script: 'y' })).toBe('Sample: y')
    expect('scriptOf' in wrapped).toBe(false)
  })
})
