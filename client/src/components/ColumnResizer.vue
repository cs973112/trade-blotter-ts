<script setup lang="ts">
import type { ResizableColumn, ResizableGrid } from '../lib/column-widths.ts'

/**
 * The resize handle at the right edge of a column header: drag it, or focus it and use the keys
 * the grid's help text describes. A separator with its width as its value, for screen readers.
 */
defineProps<{ column: ResizableColumn; grid: ResizableGrid; helpId: string }>()
</script>

<template>
  <span
    class="column-resizer"
    :class="{ active: grid.dragging.value === column.key }"
    role="separator"
    aria-orientation="vertical"
    tabindex="0"
    :aria-label="`Resize the ${column.label} column`"
    :aria-valuemin="column.minWidth"
    :aria-valuemax="column.maxWidth"
    :aria-valuenow="grid.widthOf(column.key)"
    :aria-valuetext="`${grid.widthOf(column.key)} pixels wide`"
    :aria-describedby="helpId"
    @pointerdown="grid.startDrag($event, column)"
    @pointermove="grid.moveDrag($event, column)"
    @pointerup="grid.endDrag"
    @pointercancel="grid.endDrag"
    @lostpointercapture="grid.endDrag"
    @click.stop.prevent
    @dblclick.stop.prevent="grid.fitToContents(column.key)"
    @focus="grid.remeasure()"
    @keydown="grid.resizeByKey($event, column)"
  />
</template>
