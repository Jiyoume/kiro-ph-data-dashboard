/**
 * src/map.js — Interactive Philippines Heatmap on Leaflet
 *
 * Features:
 *   - Leaflet map with dark/light tile layers (theme-aware)
 *   - Circle markers sized by revenue, coloured by metric intensity
 *   - Hover tooltip with region details
 *   - Click to drill-down (opens detail modal)
 *   - API integration: fetches data from DuckDB-WASM via queryRows
 *   - Supports metric switching (revenue, YoY, share)
 */

import L from 'leaflet';
import 'leaflet/dist/leaflet.css';

// ── Philippine Region Coordinates (approximate centroids) ─────
const REGION_COORDS = {
  'National Capital Region (NCR)':                  [14.5995, 120.9842],
  'Cordillera Administrative Region (CAR)':         [16.9500, 121.0800],
  'Region I (Ilocos Region)':                       [16.0832, 120.3860],
  'Region Ii (Cagayan Valley)':                     [17.0000, 121.8000],
  'Region Iii (Central Luzon)':                     [15.4828, 120.7120],
  'Region Iv-a (Calabarzon)':                       [14.1000, 121.3000],
  'Region Iv-b (Mimaropa)':                         [12.4000, 121.0000],
  'Region V (Bicol Region)':                        [13.4200, 123.4100],
  'Region Vi (Western Visayas)':                    [11.0050, 122.5373],
  'Region Vii (Central Visayas)':                   [9.8500, 124.0150],
  'Region Viii (Eastern Visayas)':                   [11.0000, 125.0000],
  'Region Ix (Zamboanga Peninsula)':                [7.8300, 123.2000],
  'Region X (Northern Mindanao)':                   [8.4542, 124.6319],
  'Region Xi (Davao Region)':                       [7.2000, 126.0000],
  'Region Xii (Soccsksargen)':                      [6.2700, 124.6800],
  'Region Xiii (Caraga)':                           [8.8000, 125.9000],
  'Bangsamoro Autonomous Region In Muslim Mindanao (Barmm)': [6.9500, 124.2400],
  'Large Taxpayers Service':                        [14.5995, 121.0350], // NCR area
};

// Normalise region name for lookup
function normalizeRegion(name) {
  if (!name) return '';
  return name.trim();
}

function getCoords(region) {
  const normalized = normalizeRegion(region);
  // Direct match
  if (REGION_COORDS[normalized]) return REGION_COORDS[normalized];
  // Fuzzy match by checking if key includes the region or vice versa
  for (const [key, coords] of Object.entries(REGION_COORDS)) {
    if (key.toLowerCase().includes(normalized.toLowerCase()) ||
        normalized.toLowerCase().includes(key.toLowerCase())) {
      return coords;
    }
  }
  // Fallback: center of Philippines
  return [12.8797, 121.7740];
}

// ── Map class ─────────────────────────────────────────────────
export class PhilippinesHeatmap {
  constructor(containerId) {
    this.containerId = containerId;
    this.map = null;
    this.markers = [];
    this.currentTheme = document.documentElement.getAttribute('data-theme') || 'dark';
    this.tileLayer = null;
  }

  init() {
    const container = document.getElementById(this.containerId);
    if (!container) return;

    // Init map centered on Philippines
    this.map = L.map(this.containerId, {
      center: [12.5, 122.0],
      zoom: 6,
      zoomControl: true,
      scrollWheelZoom: true,
      attributionControl: false,
    });

    this.setTileTheme(this.currentTheme);
    this.map.invalidateSize();
  }

  setTileTheme(theme) {
    if (this.tileLayer) this.map.removeLayer(this.tileLayer);

    const tileUrl = theme === 'dark'
      ? 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png'
      : 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png';

    this.tileLayer = L.tileLayer(tileUrl, {
      maxZoom: 12,
      attribution: '&copy; <a href="https://carto.com/">CARTO</a>',
    }).addTo(this.map);

    this.currentTheme = theme;
  }

  clearMarkers() {
    this.markers.forEach(m => this.map.removeLayer(m));
    this.markers = [];
  }

  /**
   * Render heatmap circles from data
   * @param {Array} data - [{region, value, year?, extra?}]
   * @param {Object} opts - {metric, onRegionClick}
   */
  render(data, opts = {}) {
    if (!this.map) return;
    this.clearMarkers();

    const { metric = 'amount_millions', onRegionClick } = opts;
    const values = data.map(d => Number(d.value) || 0).filter(v => v > 0);
    if (!values.length) return;

    const minVal = Math.min(...values);
    const maxVal = Math.max(...values);
    const range = maxVal - minVal || 1;

    for (const row of data) {
      const val = Number(row.value) || 0;
      if (val <= 0 && metric === 'amount_millions') continue;

      const coords = getCoords(row.region);
      const t = (val - minVal) / range; // 0–1 normalized

      // Size: 8px min, 45px max
      const radius = 8 + t * 37;

      // Colour based on metric type
      let color, fillColor;
      if (metric === 'yoy_pct') {
        // Diverging: red for negative, green for positive
        color = val < 0 ? '#f87171' : '#34d399';
        fillColor = val < 0 ? 'rgba(248,113,113,0.6)' : 'rgba(52,211,153,0.6)';
      } else {
        // Sequential blue intensity
        const r = Math.round(30 + t * 49);
        const g = Math.round(100 + t * 43);
        const b = Math.round(180 + t * 70);
        color = `rgb(${r},${g},${b})`;
        fillColor = `rgba(${r},${g},${b},0.55)`;
      }

      const circle = L.circleMarker(coords, {
        radius,
        color,
        fillColor,
        fillOpacity: 0.7,
        weight: 2,
        className: 'heatmap-circle',
      }).addTo(this.map);

      // Tooltip
      const formattedVal = metric === 'amount_millions'
        ? `₱${(val / 1000).toFixed(1)}B`
        : `${val.toFixed(1)}%`;

      circle.bindTooltip(
        `<div style="font-size:12px;font-weight:600;">${row.region}</div>` +
        `<div style="font-size:11px;color:#94a3b8;">${formattedVal}</div>`,
        { direction: 'top', offset: [0, -radius], className: 'map-tooltip' }
      );

      // Hover animation
      circle.on('mouseover', () => {
        circle.setStyle({ weight: 3, fillOpacity: 0.9 });
        circle.setRadius(radius * 1.2);
      });
      circle.on('mouseout', () => {
        circle.setStyle({ weight: 2, fillOpacity: 0.7 });
        circle.setRadius(radius);
      });

      // Click drill-down
      if (onRegionClick) {
        circle.on('click', () => onRegionClick(row));
      }

      this.markers.push(circle);
    }
  }

  resize() {
    if (this.map) this.map.invalidateSize();
  }

  destroy() {
    if (this.map) { this.map.remove(); this.map = null; }
  }
}
