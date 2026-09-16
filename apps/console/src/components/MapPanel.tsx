import { Layer, Map, Marker, NavigationControl, Source } from '@vis.gl/react-maplibre'
import type { ExpressionSpecification, GeoJSONSourceSpecification } from 'maplibre-gl'
import { useActiveEvent, useActiveRun } from '../lib/hooks'
import { layersFor } from '../store/fold'
import { useConsole } from '../store/stream'
import { Panel } from './ui'

type Geo = GeoJSONSourceSpecification['data']

const STYLE = 'https://tiles.openfreemap.org/styles/dark'
// the drill region; real events recentre on their own geometry
const HOME = { longitude: -77.06, latitude: 38.82, zoom: 8.4 }

// one warm ramp for shaking; the nested "at least" polygons stack, so each fill stays faint
const SHAKE_FILL: ExpressionSpecification = [
  'step',
  ['get', 'mmi'],
  '#f3d98b',
  5,
  '#f3b63c',
  6,
  '#f08a3c',
  7,
  '#ff5d4f',
  8,
  '#d7263d',
  9,
  '#a3122a',
]

const PLACE_COLOR: ExpressionSpecification = [
  'match',
  ['get', 'kind'],
  'school',
  '#9dbfe0',
  'fire_station',
  '#ff8a7a',
  'police',
  '#7ec5ff',
  'shelter',
  '#5ccb90',
  'nursing_home',
  '#d4a5ff',
  '#919ca2',
]

function pointOf(coords: unknown): [number, number] | null {
  if (Array.isArray(coords) && typeof coords[0] === 'number' && typeof coords[1] === 'number') {
    return [coords[0], coords[1]]
  }
  return null
}

function LegendDot({ color, label, ring = false }: { color: string; label: string; ring?: boolean }) {
  return (
    <span className="flex items-center gap-1.5">
      <span
        className="inline-block size-2.5 rounded-full"
        style={ring ? { border: `2px solid ${color}` } : { background: color }}
      />
      {label}
    </span>
  )
}

export function MapPanel() {
  const event = useActiveEvent()
  const run = useActiveRun()
  const layers = useConsole((s) => layersFor(s.view, run?.id ?? null))
  const point = event?.geometry.type === 'Point' ? pointOf(event.geometry.coordinates) : null
  const view = point ? { longitude: point[0], latitude: point[1], zoom: 8.6 } : HOME
  const shaking = layers.shaking
  const hospitals = layers.hospitals
  const zips = layers.zips
  const places = layers.places
  const any = Boolean(shaking || hospitals || zips || places)

  return (
    <Panel
      title="Map"
      aside={<span>{event ? event.title : 'Base map · no layers yet'}</span>}
      className="h-[290px] shrink-0"
      bodyClass="relative"
      delay={140}
    >
      <Map
        key={point ? point.join(',') : 'home'}
        initialViewState={view}
        mapStyle={STYLE}
        style={{ position: 'absolute', inset: 0 }}
        attributionControl={{ compact: true }}
        dragRotate={false}
      >
        <NavigationControl position="top-right" showCompass={false} />

        {shaking ? (
          <Source id="shaking" type="geojson" data={shaking.geojson as Geo}>
            <Layer id="shaking-fill" type="fill" paint={{ 'fill-color': SHAKE_FILL, 'fill-opacity': 0.13 }} />
            <Layer
              id="shaking-line"
              type="line"
              paint={{ 'line-color': SHAKE_FILL, 'line-width': ['step', ['get', 'mmi'], 0.6, 7, 1.6], 'line-opacity': 0.8 }}
            />
          </Source>
        ) : null}

        {places ? (
          <Source id="places" type="geojson" data={places.geojson as Geo}>
            <Layer
              id="places-dot"
              type="circle"
              minzoom={9}
              paint={{ 'circle-radius': 2, 'circle-color': PLACE_COLOR, 'circle-opacity': 0.75 }}
            />
          </Source>
        ) : null}

        {zips ? (
          <Source id="zips" type="geojson" data={zips.geojson as Geo}>
            <Layer
              id="zips-dot"
              type="circle"
              filter={['>', ['coalesce', ['get', 'power_dependent'], 0], 0]}
              paint={{
                'circle-radius': ['interpolate', ['linear'], ['sqrt', ['coalesce', ['get', 'power_dependent'], 0]], 3, 2, 30, 9],
                'circle-color': '#f3b63c',
                'circle-opacity': 0.28,
                'circle-stroke-color': '#f3b63c',
                'circle-stroke-width': 0.8,
                'circle-stroke-opacity': 0.7,
              }}
            />
          </Source>
        ) : null}

        {hospitals ? (
          <Source id="hospitals" type="geojson" data={hospitals.geojson as Geo}>
            <Layer
              id="hospitals-dot"
              type="circle"
              paint={{
                'circle-radius': ['interpolate', ['linear'], ['coalesce', ['get', 'beds'], 50], 50, 4, 1000, 11],
                'circle-color': '#ece8dd',
                'circle-opacity': 0.92,
                'circle-stroke-color': '#0f1418',
                'circle-stroke-width': 1.5,
              }}
            />
            <Layer
              id="hospitals-label"
              type="symbol"
              minzoom={10}
              layout={{ 'text-field': ['get', 'name'], 'text-size': 11, 'text-offset': [0, 1.1], 'text-anchor': 'top' }}
              paint={{ 'text-color': '#ece8dd', 'text-halo-color': '#0f1418', 'text-halo-width': 1.2 }}
            />
          </Source>
        ) : null}

        {point ? (
          <Marker longitude={point[0]} latitude={point[1]} anchor="center">
            <span className="relative flex size-5 items-center justify-center">
              <span className={`absolute size-5 rounded-full border-2 ${event?.is_drill ? 'border-drill' : 'border-live'}`} />
              <span className={`size-2 rounded-full ${event?.is_drill ? 'bg-drill' : 'bg-live'}`} />
            </span>
          </Marker>
        ) : null}
      </Map>

      {any ? (
        <div className="pointer-events-none absolute bottom-1.5 left-1.5 flex flex-wrap gap-x-3 gap-y-1 rounded-sm bg-ink-950/80 px-2 py-1 font-label text-[11px] uppercase tracking-wide text-paper-dim">
          {shaking ? <LegendDot color="#ff5d4f" label="Shaking bands" ring /> : null}
          {hospitals ? <LegendDot color="#ece8dd" label="Hospitals · size = beds" /> : null}
          {zips ? <LegendDot color="#f3b63c" label="Power-dependent residents" ring /> : null}
        </div>
      ) : null}
    </Panel>
  )
}
