import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// 以本文件所在目录为准，既能在部署目录运行，也能在暂存副本里测试。
const out = path.dirname(fileURLToPath(import.meta.url))
const base = path.resolve(out, '..', 'agent-presets')

function readPreset(id) {
  const dir = `${base}/${id}`
  const meta = fs.readFileSync(`${dir}/preset.yml`, 'utf8').replace(/\r\n/g, '\n').replace(/^\uFEFF/, '')
  const plugins = fs.readFileSync(`${dir}/agent.cordis.yml`, 'utf8').replace(/\r\n/g, '\n').replace(/\n+$/, '\n')
  const field = (key) => {
    const m = meta.match(new RegExp('^' + key + ':\\s*(.*)$', 'm'))
    return m ? m[1].trim() : ''
  }
  return { name: field('name'), description: field('description'), order: field('order'), plugins }
}

const indent = (s) => s.split('\n').map((line) => (line.trim() === '' ? '' : '          ' + line)).join('\n')

function block(meta, presetId, rowId) {
  return [
    '- insert:',
    `    - id: ${rowId}`,
    "      name: '@deepseek-ai/dsh-agent-preset'",
    '      config:',
    `        id: ${presetId}`,
    `        name: '${meta.name}'`,
    `        description: '${meta.description}'`,
    `        order: ${meta.order || 10}`,
    '        plugins:',
    indent(meta.plugins),
    ''
  ].join('\n')
}

const qc = readPreset('qq-chat')
const v2 = readPreset('qq-chat-v2')
const restricted = readPreset('restricted-standard')
const furina = readPreset('standard-furina')

const header = [
  '# QQ chat agent presets bundle: qq-chat, qq-chat-v2, restricted-standard and standard-furina.',
  '# Migrated from the legacy $DSH_HOME/.agent-presets/<id>/ layout, which this',
  '# DSH version no longer reads. Installed as a workspace bundle into the',
  '# qqbot profile; plugin list is verbatim from each agent.cordis.yml.',
  ''
].join('\n')

const guard = [
  '- insert:',
  '    - id: qq-preset-tool-restrict',
  '      name: ./qq-tool-restrict.mjs',
  ''
].join('\n')

fs.writeFileSync(`${out}/cordis.patch.yml`, header + block(qc, 'qq-chat', 'preset-qq-chat') + block(v2, 'qq-chat-v2', 'preset-qq-chat-v2') + block(restricted, 'restricted-standard', 'preset-restricted-standard') + block(furina, 'standard-furina', 'preset-standard-furina') + guard)
fs.copyFileSync(`${base}/restricted-standard/qq-tool-restrict.mjs`, `${out}/qq-tool-restrict.mjs`)
console.log('written', fs.statSync(`${out}/cordis.patch.yml`).size, 'bytes')
