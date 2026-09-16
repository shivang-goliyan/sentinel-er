import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { repoRoot } from '../config.ts'

export const seedDir = join(repoRoot, 'data', 'seeds')

export function seedPath(name: string) {
  return join(seedDir, name)
}

export function readSeed<T>(name: string): T {
  return JSON.parse(readFileSync(seedPath(name), 'utf8')) as T
}

export function readSeedIfThere<T>(name: string): T | null {
  const p = seedPath(name)
  return existsSync(p) ? (JSON.parse(readFileSync(p, 'utf8')) as T) : null
}

const R_EARTH = 6371.0088

export function haversineKm(lon1: number, lat1: number, lon2: number, lat2: number) {
  const toRad = Math.PI / 180
  const dLat = (lat2 - lat1) * toRad
  const dLon = (lon2 - lon1) * toRad
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLon / 2) ** 2
  return 2 * R_EARTH * Math.asin(Math.min(1, Math.sqrt(a)))
}
