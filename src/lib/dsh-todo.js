/**
 * Bridge to the DSH todo store owned by dsh-memory-evolve (`dtodo` tool).
 *
 * Meeting action items are written to the **work** track
 * (`<dsh-home>/memories/TODOS-work.md`). The store is imported from the same
 * profile's node_modules, so entry formatting, directory locking and validation
 * stay identical to what the `dtodo` tool writes.
 *
 * @module dsh-plugin-meeting-minutes/dsh-todo
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))

/** Candidate locations of the memory-evolve todo module (same profile). */
function candidatePaths() {
  const moduleRoot = path.join(HERE, '..', '..')
  return [path.join(moduleRoot, 'dsh-memory-evolve', 'lib', 'todo.js')]
}

/**
 * Create the todo bridge. Loading is lazy so the host plugin can call this from a
 * synchronous `apply()`.
 * @param options - `{ logger }`.
 */
export function createDshTodo({ logger } = {}) {
  let store = null
  let memoryDir = null
  let error = null
  let loading = null

  async function load() {
    if (store !== null || error !== null) return store
    if (loading !== null) return loading
    loading = (async () => {
      for (const candidate of candidatePaths()) {
        try {
          if (!fs.existsSync(candidate)) continue
          const module = await import(pathToFileURL(candidate).href)
          const dshHome = process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh')
          memoryDir = process.env.DSH_MEMORY_DIR ?? path.join(dshHome, 'memories')
          store = new module.TodoStore(memoryDir)
          logger?.info?.(`meeting-minutes: dsh todo ready (${memoryDir})`)
          return store
        } catch (caught) {
          error = caught
        }
      }
      logger?.warn?.(`meeting-minutes: dsh todo unavailable: ${error === null ? 'dsh-memory-evolve not installed' : String(error.message ?? error)}`)
      return null
    })()
    return loading
  }

  return {
    /** Try to load the store once; resolves true when usable. */
    async ready() {
      return (await load()) !== null
    },
    /** Synchronous status (before a ready() call this reports unavailable). */
    status() {
      return {
        available: store !== null,
        target: 'dsh-todo',
        dir: memoryDir,
        error: error === null ? null : String(error.message ?? error),
      }
    },
    /**
     * Calendar-shaped status for the panel: prefers the DSH todo store and falls
     * back to the task-calendar plugin when the todo store cannot be loaded.
     */
    async describe(fallback, detailed = false) {
      await load()
      if (store !== null) return { available: true, target: 'dsh-todo', dir: memoryDir }
      try {
        return await fallback.status(detailed)
      } catch (caught) {
        return { available: false, target: 'dsh-todo', error: String(caught?.message ?? caught) }
      }
    },
    /** Append one action item to the work track. */
    add(content, meta = {}) {
      if (store === null) return { ok: false, message: 'DSH 待办存储尚未就绪' }
      try {
        return store.addTodo('work', content, meta)
      } catch (caught) {
        return { ok: false, message: String(caught?.message ?? caught) }
      }
    },
  }
}
