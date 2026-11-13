<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, useId, useTemplateRef } from 'vue'

import type { ColumnVisibility } from '../lib/column-visibility.ts'

/**
 * The Columns button for one grid, and the list of its columns it opens: a check box for each,
 * essential ones checked and fixed, and how many are shown. Show all columns shows every column,
 * those hidden by default included, and leaves the list open with focus where it was; with every
 * column shown it is marked unavailable (aria-disabled, so it keeps focus) and does nothing.
 * Restore default columns puts back what the grid starts with, hiding again any column hidden by
 * default; at the defaults it is marked unavailable in the same way and does nothing. Escape, or
 * choosing anywhere else on the page, closes the list; Escape returns to the button.
 */
const props = defineProps<{ visibility: ColumnVisibility; gridLabel: string }>()

const open = ref(false)
const id = useId()
const button = useTemplateRef<HTMLButtonElement>('button')
const root = useTemplateRef<HTMLElement>('root')

function closeOnOutside(event: PointerEvent): void {
  if (root.value !== null && event.target instanceof Node && !root.value.contains(event.target)) close(false)
}

function close(returnFocus: boolean): void {
  if (!open.value) return
  open.value = false
  document.removeEventListener('pointerdown', closeOnOutside, true)
  if (returnFocus) button.value?.focus()
}

async function toggle(): Promise<void> {
  if (open.value) {
    close(false)
    return
  }
  open.value = true
  document.addEventListener('pointerdown', closeOnOutside, true)
  await nextTick()
  root.value?.querySelector<HTMLInputElement>('input:not(:disabled)')?.focus()
}

function onKey(event: KeyboardEvent): void {
  if (event.key !== 'Escape' || !open.value) return
  event.preventDefault()
  event.stopPropagation()
  close(true)
}

const count = computed(() => `${String(props.visibility.visibleColumns.value.length)} of ${String(props.visibility.columns.length)} columns shown`)

function showAll(): void {
  if (props.visibility.allVisible.value) return
  props.visibility.showAll()
}

function restoreDefaults(): void {
  if (props.visibility.atDefaults.value) return
  props.visibility.restoreDefaults()
}

function change(key: string, event: Event): void {
  props.visibility.setShown(key, (event.target as HTMLInputElement).checked)
}

onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', closeOnOutside, true)
})
</script>

<template>
  <div ref="root" class="column-chooser" @keydown="onKey">
    <button
      ref="button"
      type="button"
      class="button-secondary"
      :aria-expanded="open"
      :aria-controls="`${id}-panel`"
      @click="toggle()"
    >
      Columns<span class="visually-hidden"> of the {{ gridLabel }}</span>
    </button>
    <div v-show="open" :id="`${id}-panel`" class="column-chooser-panel">
      <fieldset>
        <legend>Columns shown in the {{ gridLabel }}</legend>
        <label v-for="column in visibility.columns" :key="column.key" class="column-option">
          <input
            type="checkbox"
            :checked="visibility.isShown(column.key)"
            :disabled="column.essential === true"
            :data-column="column.key"
            @change="change(column.key, $event)"
          >
          {{ column.label }}<span v-if="column.essential" class="hint"> (always shown)</span>
        </label>
      </fieldset>
      <p class="column-count" aria-live="polite">{{ count }}</p>
      <div class="column-chooser-actions">
        <button
          type="button"
          class="button-secondary show-all-columns"
          :aria-disabled="visibility.allVisible.value ? 'true' : 'false'"
          @click="showAll()"
        >
          Show all columns
        </button>
        <button
          type="button"
          class="button-secondary restore-columns"
          :aria-disabled="visibility.atDefaults.value ? 'true' : 'false'"
          @click="restoreDefaults()"
        >
          Restore default columns
        </button>
      </div>
    </div>
  </div>
</template>
