import { useSyncExternalStore } from 'react'
import { route, type MffaiRoute } from './route'

export function useRoute(): MffaiRoute {
  return useSyncExternalStore(route.subscribe, route.get)
}
