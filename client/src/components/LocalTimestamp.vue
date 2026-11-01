<script setup lang="ts">
import { computed } from 'vue'

import { displayTime } from '../lib/timestamps.ts'

const props = defineProps<{ utc: string }>()

const time = computed(() => displayTime(props.utc))
</script>

<template>
  <time :datetime="time.utc" :title="`${time.utc} (UTC)`" class="timestamp">
    {{ time.local }} <span class="offset">{{ time.offset }}</span>
  </time>
</template>
