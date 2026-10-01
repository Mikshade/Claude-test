import { describe, expect, it } from 'vitest'
import {
  collectManifestFiles,
  fileUrl,
  hasCubismCoreHeader,
  isSafeRelativePath,
  licenseNotice,
  manifestFilePaths,
  normalizeModelName,
  normalizeRelativePath,
  SAMPLE_CREDIT_LINE,
  SAMPLE_MODELS,
  sampleModelSources,
  sourceNotice,
} from './lib/live2dManifest.mjs'

/** Trimmed copy of Hiyori.model3.json (tag 5-r.5) plus Haru-style expressions/sounds and a 5.x MotionSync key. */
const SAMPLE_MANIFEST = {
  Version: 3,
  FileReferences: {
    Moc: 'Hiyori.moc3',
    Textures: ['Hiyori.2048/texture_00.png', 'Hiyori.2048/texture_01.png'],
    Physics: 'Hiyori.physics3.json',
    Pose: 'Hiyori.pose3.json',
    UserData: 'Hiyori.userdata3.json',
    DisplayInfo: 'Hiyori.cdi3.json',
    MotionSync: 'Hiyori.motionsync3.json',
    Expressions: [
      { Name: 'F01', File: 'expressions/F01.exp3.json' },
      { Name: 'F02', File: 'expressions/F02.exp3.json' },
    ],
    Motions: {
      Idle: [
        { File: 'motions/Hiyori_m01.motion3.json', FadeInTime: 0.5, FadeOutTime: 0.5 },
        { File: 'motions/Hiyori_m02.motion3.json', FadeInTime: 0.5, FadeOutTime: 0.5 },
      ],
      TapBody: [{ File: 'motions/Hiyori_m04.motion3.json', Sound: 'sounds/tap.wav' }],
    },
  },
  Groups: [{ Target: 'Parameter', Name: 'LipSync', Ids: ['ParamMouthOpenY'] }],
  HitAreas: [{ Id: 'HitArea', Name: 'Body' }],
}

describe('collectManifestFiles', () => {
  it('walks every FileReferences entry in a stable order with kinds', () => {
    expect(collectManifestFiles(SAMPLE_MANIFEST)).toEqual([
      { path: 'Hiyori.moc3', kind: 'moc' },
      { path: 'Hiyori.2048/texture_00.png', kind: 'texture' },
      { path: 'Hiyori.2048/texture_01.png', kind: 'texture' },
      { path: 'Hiyori.physics3.json', kind: 'physics' },
      { path: 'Hiyori.pose3.json', kind: 'pose' },
      { path: 'Hiyori.cdi3.json', kind: 'displayInfo' },
      { path: 'Hiyori.userdata3.json', kind: 'userData' },
      { path: 'Hiyori.motionsync3.json', kind: 'motionSync' },
      { path: 'expressions/F01.exp3.json', kind: 'expression' },
      { path: 'expressions/F02.exp3.json', kind: 'expression' },
      { path: 'motions/Hiyori_m01.motion3.json', kind: 'motion' },
      { path: 'motions/Hiyori_m02.motion3.json', kind: 'motion' },
      { path: 'motions/Hiyori_m04.motion3.json', kind: 'motion' },
      { path: 'sounds/tap.wav', kind: 'sound' },
    ])
  })

  it('handles minimal manifests (Moc + Textures only) and ignores empty/missing keys', () => {
    expect(manifestFilePaths({ FileReferences: { Moc: 'a.moc3', Textures: ['t.png'], Physics: '', Motions: {} } })).toEqual([
      'a.moc3',
      't.png',
    ])
  })

  it('deduplicates files referenced twice (shared sound, same motion in two groups)', () => {
    const manifest = {
      FileReferences: {
        Moc: 'x.moc3',
        Motions: {
          Idle: [{ File: 'm/a.motion3.json', Sound: 's/a.wav' }],
          Tap: [{ File: 'm/a.motion3.json', Sound: 's/a.wav' }],
        },
      },
    }
    expect(manifestFilePaths(manifest)).toEqual(['x.moc3', 'm/a.motion3.json', 's/a.wav'])
  })

  it('normalises backslashes and ./ prefixes', () => {
    const manifest = { FileReferences: { Moc: '.\\Model.moc3', Textures: ['./tex\\a.png', 'tex//b.png'] } }
    expect(manifestFilePaths(manifest)).toEqual(['Model.moc3', 'tex/a.png', 'tex/b.png'])
  })

  it('accepts unknown future keys that hold strings or {File} arrays', () => {
    const manifest = {
      FileReferences: {
        Moc: 'x.moc3',
        Future: 'future.bin',
        FutureList: ['f1.bin', { File: 'f2.bin' }],
        Meta: { not: 'a file' },
        Count: 3,
      },
    }
    expect(collectManifestFiles(manifest)).toEqual([
      { path: 'x.moc3', kind: 'moc' },
      { path: 'future.bin', kind: 'other' },
      { path: 'f1.bin', kind: 'other' },
      { path: 'f2.bin', kind: 'other' },
    ])
  })

  it('rejects traversal, absolute paths and URLs', () => {
    expect(() => collectManifestFiles({ FileReferences: { Moc: '../x.moc3' } })).toThrow(/outside the model directory/)
    expect(() => collectManifestFiles({ FileReferences: { Moc: '/etc/passwd' } })).toThrow(/outside/)
    expect(() => collectManifestFiles({ FileReferences: { Moc: 'C:\\x.moc3' } })).toThrow(/outside/)
    expect(() => collectManifestFiles({ FileReferences: { Textures: ['https://evil.example/t.png'] } })).toThrow(/outside/)
    expect(() => collectManifestFiles({ FileReferences: { Motions: { Idle: [{ File: 'a/../../b.json' }] } } })).toThrow(/outside/)
  })

  it('rejects malformed manifests with readable errors', () => {
    expect(() => collectManifestFiles(null)).toThrow(/not a JSON object/)
    expect(() => collectManifestFiles({})).toThrow(/FileReferences/)
    expect(() => collectManifestFiles({ FileReferences: [] })).toThrow(/FileReferences/)
    expect(() => collectManifestFiles({ FileReferences: { Moc: 42 } })).toThrow(/Moc must be a string/)
    expect(() => collectManifestFiles({ FileReferences: { Textures: 'x.png' } })).toThrow(/Textures must be an array/)
    expect(() => collectManifestFiles({ FileReferences: { Motions: [] } })).toThrow(/Motions must be an object/)
    expect(() => collectManifestFiles({ FileReferences: { Expressions: [5] } })).toThrow(/unexpected shape/)
  })
})

describe('path helpers', () => {
  it('normalizeRelativePath', () => {
    expect(normalizeRelativePath('./a/./b.png')).toBe('a/./b.png')
    expect(normalizeRelativePath('a\\b\\\\c.png')).toBe('a/b/c.png')
    expect(normalizeRelativePath('././x')).toBe('x')
  })

  it('isSafeRelativePath', () => {
    expect(isSafeRelativePath('a.moc3')).toBe(true)
    expect(isSafeRelativePath('dir/sub/file.json')).toBe(true)
    expect(isSafeRelativePath('')).toBe(false)
    expect(isSafeRelativePath('..')).toBe(false)
    expect(isSafeRelativePath('a/../b')).toBe(false)
    expect(isSafeRelativePath('/abs')).toBe(false)
    expect(isSafeRelativePath('D:/x')).toBe(false)
    expect(isSafeRelativePath('a//b')).toBe(false)
    expect(isSafeRelativePath('a/./b')).toBe(false)
    expect(isSafeRelativePath('a\0b')).toBe(false)
    expect(isSafeRelativePath('ftp://host/x')).toBe(false)
  })

  it('fileUrl encodes each segment and tolerates a missing trailing slash', () => {
    expect(fileUrl('https://cdn.example/base/', 'Hiyori.2048/texture_00.png')).toBe(
      'https://cdn.example/base/Hiyori.2048/texture_00.png',
    )
    expect(fileUrl('https://cdn.example/base', 'a b/c#d.json')).toBe('https://cdn.example/base/a%20b/c%23d.json')
  })
})

describe('sample model sources', () => {
  it('normalizeModelName is case-insensitive and rejects unknown names', () => {
    expect(normalizeModelName('hiyori')).toBe('Hiyori')
    expect(normalizeModelName(' HARU ')).toBe('Haru')
    expect(normalizeModelName('Mao')).toBe('Mao')
    expect(normalizeModelName('natori')).toBe('Natori')
    expect(normalizeModelName('Shizuku')).toBeNull()
    expect(normalizeModelName('')).toBeNull()
    expect(normalizeModelName(undefined)).toBeNull()
    expect(SAMPLE_MODELS).toEqual(['Hiyori', 'Haru', 'Mao', 'Natori'])
  })

  it('builds the jsDelivr primary and raw.githubusercontent fallback URLs pinned to the tag', () => {
    const s = sampleModelSources('hiyori')
    expect(s).toEqual({
      model: 'Hiyori',
      tag: '5-r.5',
      manifest: 'Hiyori.model3.json',
      primary: 'https://cdn.jsdelivr.net/gh/Live2D/CubismWebSamples@5-r.5/Samples/Resources/Hiyori/',
      fallback: 'https://raw.githubusercontent.com/Live2D/CubismWebSamples/5-r.5/Samples/Resources/Hiyori/',
      licenseUrl: 'https://cdn.jsdelivr.net/gh/Live2D/CubismWebSamples@5-r.5/LICENSE.md',
      repoUrl: 'https://github.com/Live2D/CubismWebSamples/tree/5-r.5/Samples/Resources/Hiyori',
    })
    expect(sampleModelSources('Mao', '4-r.7').primary).toBe(
      'https://cdn.jsdelivr.net/gh/Live2D/CubismWebSamples@4-r.7/Samples/Resources/Mao/',
    )
    expect(() => sampleModelSources('nope')).toThrow(/Unknown sample model/)
  })
})

describe('notices', () => {
  it('hasCubismCoreHeader requires the official header markers near the top', () => {
    const header = [
      '/**',
      ' * Live2D Cubism Core',
      ' * (C) 2019 Live2D Inc. All rights reserved.',
      ' *',
      ' * This file is licensed pursuant to the license agreement below.',
      ' * This file corresponds to the "Redistributable Code" in the agreement.',
      ' * https://www.live2d.com/eula/live2d-proprietary-software-license-agreement_en.html',
      ' */',
      'var Live2DCubismCore;',
    ].join('\n')
    expect(hasCubismCoreHeader(header)).toBe(true)
    expect(hasCubismCoreHeader('<!doctype html><title>404</title>')).toBe(false)
    expect(hasCubismCoreHeader(`${'x'.repeat(1000)}${header}`)).toBe(false)
  })

  it('licenseNotice carries the credit line and the Natori caveat only for Natori', () => {
    const hiyori = licenseNotice(sampleModelSources('Hiyori'))
    expect(hiyori).toContain(SAMPLE_CREDIT_LINE)
    expect(hiyori).toContain('Free Material License')
    expect(hiyori).toContain('tag 5-r.5')
    expect(hiyori).not.toContain('collaboration character')
    expect(licenseNotice(sampleModelSources('Natori'))).toContain('collaboration character')
  })

  it('sourceNotice lists url, tag and files', () => {
    const text = sourceNotice(sampleModelSources('Haru'), ['Haru.model3.json', 'Haru.moc3'], new Date('2026-10-01T12:00:00Z'))
    expect(text).toContain('model: Haru')
    expect(text).toContain('tag: 5-r.5')
    expect(text).toContain('cdn: https://cdn.jsdelivr.net/gh/Live2D/CubismWebSamples@5-r.5/Samples/Resources/Haru/')
    expect(text).toContain('downloaded: 2026-10-01T12:00:00.000Z')
    expect(text).toContain('  Haru.moc3\n')
  })
})
