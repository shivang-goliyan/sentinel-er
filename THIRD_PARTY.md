# Third-party libraries, APIs and data

Every external dependency this project uses, as the event rules require. Keep this file current:
anything added to the code gets a row here in the same change.

The licence columns for libraries are filled from package metadata (`npx license-checker
--summary`, `uv run pip-licenses`). Don't type them by hand.

## APIs and services

| Service | Used for | Access / terms |
|---|---|---|
| USGS Earthquake Hazards (ComCat, feeds, PAGER, ShakeMap, DYFI) | Live and historical earthquakes, exposure, intensity, training features | Public domain (US Government) |
| NOAA NCEI Significant Earthquake Database (HazEL) | Casualty labels | Public domain |
| NASA FIRMS | Active fire detections | Free MAP_KEY |
| NASA EONET | Natural event feed | Public |
| GDACS | Multi-hazard alerts | Public (EC JRC / UN OCHA) |
| Google Flood Hub API | Flood forecasts | Google Cloud key; access terms per Google |
| NOAA SWPC | Space weather alerts | Public domain |
| NOAA NHC GIS | Hurricane cones and wind-speed probabilities (live and archive) | Public domain |
| NOAA HRRR (AWS Open Data) | Near-surface smoke forecast | Public domain, via the NOAA Open Data Dissemination program |
| NWS API and HeatRisk | Alerts and heat-health risk | Public domain |
| Open-Meteo (weather; air quality from Copernicus CAMS) | Weather, PM2.5 forecast and history | Free non-commercial use, CC-BY 4.0 attribution |
| OpenAQ | PM2.5 observations | Free API key |
| AirNow API | Air-quality observations and forecasts | Free API key |
| EPA AirData | Historical daily PM2.5 for training | Public domain |
| HHS emPOWER REST service + historical dataset | ZIP-level power-dependent Medicare counts | Public |
| CMS Provider Data (Hospital General Information, nursing homes) | Hospital and facility directory | Public |
| CMS Provider of Services file | Bed counts | Public |
| FEMA Hospitals RAPT layer (HIFLD hospitals copy) | Hospital coordinates, beds, trauma | Public Use |
| HHS facility-level hospital capacity (healthdata.gov) | Historical occupancy baseline | Public |
| CDC NHSN hospital respiratory data (data.cdc.gov) | Current occupancy | Public |
| NYC Health syndromic surveillance (EpiQuery) | Daily asthma ED visits for training | Public |
| US Census Bureau (Geocoder, Centers of Population, ZCTA Gazetteer) | Geocoding, population, ZIP points | Public domain |
| World Bank API | Country income classification | CC-BY 4.0 |
| Natural Earth (admin-0 countries, from its GitHub mirror) | Country lookup for training events | Public domain |
| FEMA National Shelter System open shelters | Open shelters near affected ZIPs | Public |
| OpenStreetMap via Overpass API | POIs, substations, emergency entrances | ODbL, © OpenStreetMap contributors |
| OpenRouteService | Hazard-avoiding routes | Free API key; ORS terms |
| OSRM demo server | Drive times | Demo server usage policy |
| Valhalla (FOSSGIS public server) | Fallback routing around small areas | FOSSGIS usage policy |
| OpenFreeMap | Map tiles and styles | Free; © OpenMapTiles, © OpenStreetMap contributors |
| Google Places API (New) | Hospital phone, hours, website | Paid Google Maps Platform |
| Bright Data (Web Unlocker, Google Maps data) | Fetching blocked hospital pages; busyness proxy; utility shutoff notices | Paid |
| Twilio Programmable Voice, Media Streams, Voice JS SDK | Phone calls | Paid |
| Deepgram (Nova-3 speech-to-text, Aura-2 text-to-speech) | Hearing and speaking on calls | Paid |
| Groq API | Language model inference | Groq terms |
| Google Gemini API | Language model inference | Google AI terms |
| OpenRouter | Language model inference (fallback) | OpenRouter terms |
| OpenTimestamps public calendars | Anchoring the log to Bitcoin | Free public service |

## Hosts the code talks to

Checked by a test: every host named in the source must be listed here.

| Host | Belongs to |
|---|---|
| earthquake.usgs.gov | USGS Earthquake Hazards |
| www.sciencebase.gov | USGS PAGER-CAT download |
| raw.githubusercontent.com | USGS PAGER `fatality.xml`; Natural Earth |
| www.ngdc.noaa.gov | NOAA NCEI HazEL |
| firms.modaps.eosdis.nasa.gov | NASA FIRMS |
| eonet.gsfc.nasa.gov | NASA EONET |
| www.gdacs.org | GDACS |
| services.swpc.noaa.gov, www.swpc.noaa.gov | NOAA SWPC |
| noaa-hrrr-bdp-pds.s3.amazonaws.com, registry.opendata.aws | NOAA HRRR on AWS Open Data |
| api.weather.gov, mapservices.weather.noaa.gov, www.wpc.ncep.noaa.gov | NWS API and HeatRisk |
| api.open-meteo.com, archive-api.open-meteo.com, air-quality-api.open-meteo.com | Open-Meteo |
| aqs.epa.gov | EPA AirData |
| services.arcgis.com, services2.arcgis.com | Esri-hosted layers: HHS emPOWER, FEMA Hospitals RAPT, NHC |
| gis.fema.gov | FEMA National Shelter System |
| data.cms.gov | CMS Provider Data |
| healthdata.gov | HHS facility capacity history |
| data.cdc.gov | CDC NHSN |
| a816-healthtableau.nyc.gov | NYC Health EpiQuery |
| geocoding.geo.census.gov, www2.census.gov | US Census Bureau |
| api.worldbank.org, datacatalogfiles.worldbank.org | World Bank |
| overpass-api.de, overpass.private.coffee | Overpass API (main instance and a public mirror) |
| www.openstreetmap.org | OpenStreetMap (source links) |
| router.project-osrm.org | OSRM demo server |
| api.openrouteservice.org | OpenRouteService |
| tiles.openfreemap.org | OpenFreeMap |
| places.googleapis.com | Google Places API |
| generativelanguage.googleapis.com | Google Gemini API |
| api.groq.com | Groq |
| openrouter.ai | OpenRouter |
| api.brightdata.com | Bright Data |
| www.inova.org | Hospital website fetched through Bright Data (Phase 0 check) |
| api.twilio.com | Twilio |
| api.deepgram.com | Deepgram |
| github.com | This repository (User-Agent and source links) |
| doi.org | Citation links for published dose-response figures |
| turkishminute.com, www.gfdrr.org | Citation links for official death tolls shown beside the grade |

## Published models and parameters

| Source | Used for |
|---|---|
| Atkinson, Worden & Wald (2014), BSSA 104(6) | Intensity prediction equation |
| Worden et al. (2012), BSSA 102(1) | MMI ↔ PGA conversion |
| FEMA HAZUS 6.1 Earthquake Technical Manual | Substation fragility and restoration; hospital functionality |
| Jaiswal & Wald (2010), Earthquake Spectra 26(4); USGS PAGER `fatality.xml` | Baseline fatality model |
| USGS PAGER-CAT and EXPO-CAT catalogues | Casualty model training data |
| CDC MMWR 72(34) (McArdle et al., 2023) | Context for the smoke validation |
| Gan et al. (2020), J Expo Sci Environ Epidemiol 30 | Smoke → asthma ED concentration-response (the served smoke term) |
| Sun et al. (2021), BMJ 375:e065653 | Extreme heat → ED visit percent change |

## JavaScript / TypeScript libraries

| Package | Used for |
|---|---|
| fastify, @fastify/websocket, @fastify/formbody | HTTP, SSE, WebSockets, Twilio form webhooks |
| zod | Schemas shared by server and console |
| better-sqlite3, drizzle-orm, drizzle-kit | Database and migrations |
| openai | OpenAI-compatible client for the LLM chain |
| twilio | Twilio REST client |
| ws | Deepgram streaming socket |
| @twilio/voice-sdk | Browser softphone |
| @turf/* | Geometry |
| kdbush, geokdbush | Spatial indexes |
| d3-contour | Intensity contours |
| playwright-core | Sitrep PDF rendering (headless Chromium) |
| opentimestamps | Log anchoring |
| react, react-dom, vite, @vitejs/plugin-react | Console |
| tailwindcss, @tailwindcss/vite | Styling |
| maplibre-gl, @vis.gl/react-maplibre | Map |
| recharts | Charts |
| @fontsource-variable/public-sans, @fontsource/barlow-condensed, @fontsource-variable/red-hat-mono | Self-hosted console fonts (Public Sans, Barlow Condensed, Red Hat Mono; SIL Open Font License) |
| zustand | Console state |
| typescript, @types/node, @types/better-sqlite3, @types/d3-contour, @types/ws, @types/react, @types/react-dom | Type checking |
| vitest | Tests |

## Python libraries

| Package | Used for |
|---|---|
| fastapi, uvicorn | Science service |
| lightgbm | Casualty model |
| numpy, pandas, scikit-learn, statsmodels | Data and modelling |
| requests | Downloading source datasets |
| xarray, cfgrib, eccodes | GRIB2 decoding |
| herbie-data | HRRR byte-range subsetting |
| matplotlib | Validation charts |
| openpyxl | Reading the emPOWER historical workbook |
| pytest | Tests |
