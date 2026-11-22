<script setup lang="ts">
import { computed } from 'vue'

import { displayTime } from '../lib/timestamps.ts'

// Null: no time, such as a Pending trade's execution time (shown as a dash).
const props = withDefaults(defineProps<{ utc: string | null; none?: string }>(), { none: 'No time' })

const time = computed(() => props.utc === null ? undefined : displayTime(props.utc))
</script>

<template>
  <time v-if="time !== undefined" :datetime="time.utc" :title="`${time.utc} (UTC)`" class="timestamp">
    {{ time.local }} <span class="offset">{{ time.offset }}</span>
  </time>
  <span v-else class="timestamp none" :aria-label="none" :title="none">—</span>
</template>
