/**
 * Permissions page: access level with plain-language consequences, per-category toggles, elevation
 * status and the "restart as administrator" button – behind a prominent warning.
 *
 * OWNER: settings-ui agent.
 */
import type { PermissionLevel, PermissionsConfig } from '@shared/config'
import { t } from '../i18n'
import { asyncButton, el, field, note, section } from '../ui'
import { boundRadio, boundToggle } from './bind'
import type { Page } from './context'

type CategoryKey = Exclude<keyof PermissionsConfig, 'level'>

const CATEGORIES: ReadonlyArray<{ key: CategoryKey; labelKey: 'perm.shell' | 'perm.files' | 'perm.screenshots' | 'perm.web' | 'perm.input' | 'perm.power'; descKey: 'perm.shellDesc' | 'perm.filesDesc' | 'perm.screenshotsDesc' | 'perm.webDesc' | 'perm.inputDesc' | 'perm.powerDesc' }> = [
  { key: 'allowShell', labelKey: 'perm.shell', descKey: 'perm.shellDesc' },
  { key: 'allowFiles', labelKey: 'perm.files', descKey: 'perm.filesDesc' },
  { key: 'allowScreenshots', labelKey: 'perm.screenshots', descKey: 'perm.screenshotsDesc' },
  { key: 'allowWeb', labelKey: 'perm.web', descKey: 'perm.webDesc' },
  { key: 'allowInput', labelKey: 'perm.input', descKey: 'perm.inputDesc' },
  { key: 'allowPower', labelKey: 'perm.power', descKey: 'perm.powerDesc' },
]

export const permissionsPage: Page = {
  id: 'permissions',
  titleKey: 'perm.title',
  descriptionKey: 'perm.desc',
  render(ctx) {
    const levels: Array<{ value: PermissionLevel; label: string; description: string }> = [
      { value: 'full', label: t('level.full'), description: t('level.fullDesc') },
      { value: 'confirm-destructive', label: t('level.confirm-destructive'), description: t('level.confirm-destructiveDesc') },
      { value: 'read-only', label: t('level.read-only'), description: t('level.read-onlyDesc') },
    ]
    const warning = note('danger', el('strong', null, t('perm.warningTitle')), el('br'), t('perm.warning'))

    const level = section(t('perm.level'), null, boundRadio<PermissionLevel>(ctx, 'permissions.level', levels))

    const categories = section(
      t('perm.categories'),
      t('perm.categoriesDesc'),
      CATEGORIES.map((c) => boundToggle(ctx, `permissions.${c.key}`, t(c.labelKey), t(c.descKey))),
    )

    const info = ctx.info
    const isWindows = info?.platform === 'win32'
    const elevated = info?.elevated === true
    const relaunch = asyncButton(
      t('perm.relaunch'),
      t('perm.relaunch'),
      async () => {
        await ctx.store.flush()
        await window.flowy.invoke('app:relaunchElevated')
      },
      { variant: 'secondary', disabled: !isWindows || elevated },
    )
    const elevation = section(
      t('perm.elevation'),
      t('perm.elevationDesc'),
      note(elevated ? 'warn' : 'info', elevated ? t('perm.elevatedYes') : t('perm.elevatedNo')),
      field('', el('div', { class: 'test-row' }, relaunch, isWindows ? null : el('span', { class: 'muted' }, t('perm.relaunchWinOnly')))),
    )

    return el('div', { class: 'page' }, warning, level, categories, elevation)
  },
}
