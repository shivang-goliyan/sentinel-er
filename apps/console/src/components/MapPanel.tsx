import { Map, Marker, NavigationControl } from '@vis.gl/react-maplibre'
import { useActiveEvent } from '../lib/hooks'
import { Panel } from './ui'

const STYLE = 'https://tiles.openfreemap.org/styles/dark'
// the drill region; real events recentre on their own geometry
const HOME = { longitude: -77.06, latitude: 38.82, zoom: 8.4 }

function pointOf(coords: unknown): [number, number] | null {
  if (Array.isArray(coords) && typeof coords[0] === 'number' && typeof coords[1] === 'number') {
    return [coords[0], coords[1]]
  }
  return null
}

export function MapPanel() {
  const event = useActiveEvent()
  const point = event?.geometry.type === 'Point' ? pointOf(event.geometry.coordinates) : null
  const view = point ? { longitude: point[0], latitude: point[1], zoom: 8.4 } : HOME

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
        {point ? (
          <Marker longitude={point[0]} latitude={point[1]} anchor="center">
            <span className="relative flex size-5 items-center justify-center">
              <span className={`absolute size-5 rounded-full border-2 ${event?.is_drill ? 'border-drill' : 'border-live'}`} />
              <span className={`size-2 rounded-full ${event?.is_drill ? 'bg-drill' : 'bg-live'}`} />
            </span>
          </Marker>
        ) : null}
      </Map>
    </Panel>
  )
}
