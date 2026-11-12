/**
 * Extra 展示层 —— SPEC §12。规则真源已搬到 ../shared/spec-rules.js，
 * 这里只保留 Host 侧稳定的导出名（避免一次改所有调用点）。
 */

export {
  ACTION_KINDS,
  CHART_KINDS,
  LAYOUT_DIRECTIONS,
  LIMITS,
  MEDIA_KINDS,
  MEDIA_PATH_PATTERN,
  UI_PROTOCOL,
  WIDGET_KINDS,
  WIDGET_PRESETS,
  isAllowedMediaPath,
  layoutDepth,
  validateSpec,
  widgetFallbackText,
} from '../shared/spec-rules.js'

import { validateSpec } from '../shared/spec-rules.js'

/** Host 侧历史名字：validateWidget。 */
export function validateWidget(input) {
  return validateSpec(input)
}
