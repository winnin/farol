import { ERROR_PREFIX } from '../errors/admin-errors'

export function wrap(text: string): string {
  return `${ERROR_PREFIX}${text}`
}
