import type { ChoroplethData } from '@/types/geojson';

/**
 * Generate a color based on crime count using a blue-to-red gradient
 * Blue = low crime, Red = high crime
 */
export function getChoroplethColor(
  count: number,
  scale: ChoroplethData['scale'],
  opacity: number = 0.2
): string {
  if (count === 0) {
    return `rgba(107, 114, 128, ${opacity})`; // Gray for no data
  }

  // Handle edge cases where scale values might be the same (very sparse data)
  const range = scale.max - scale.min;
  if (range === 0 || scale.min === scale.max) {
    // All values are the same - use a middle color
    console.log(`[Choropleth] Uniform data detected: count=${count}, scale=${JSON.stringify(scale)}`);
    return `rgba(124, 255, 102, ${opacity})`; // Light green for uniform data
  }

  // Normalize the count to a 0-1 scale using percentiles
  let normalizedValue: number;
  
  // Check for division by zero scenarios and handle gracefully
  const p50Range = scale.p50 - scale.min;
  const p90Range = scale.p90 - scale.p50;
  const maxRange = scale.max - scale.p90;
  
  if (count <= scale.p50) {
    // Low crime: 0 to 0.5 (blue to light blue)
    if (p50Range === 0) {
      normalizedValue = 0.25; // Default to low-medium if no range
    } else {
      normalizedValue = (count - scale.min) / p50Range * 0.5;
    }
  } else if (count <= scale.p90) {
    // Medium crime: 0.5 to 0.8 (light blue to orange)
    if (p90Range === 0) {
      normalizedValue = 0.65; // Default to medium-high if no range
    } else {
      normalizedValue = 0.5 + (count - scale.p50) / p90Range * 0.3;
    }
  } else {
    // High crime: 0.8 to 1.0 (orange to red)
    if (maxRange === 0) {
      normalizedValue = 0.9; // Default to high if no range
    } else {
      normalizedValue = 0.8 + (count - scale.p90) / maxRange * 0.2;
    }
  }

  // Clamp to 0-1 range
  normalizedValue = Math.max(0, Math.min(1, normalizedValue));

  // Color spectrum points
  const colorStops = [
    { value: 0.00, color: [0, 58, 153] },     // #003A99 - darkest blue
    { value: 0.10, color: [42, 167, 255] },   // #2AA7FF
    { value: 0.30, color: [0, 255, 204] },    // #00FFCC
    { value: 0.50, color: [124, 255, 102] },  // #7CFF66
    { value: 0.70, color: [217, 255, 61] },   // #D9FF3D
    { value: 0.85, color: [255, 153, 0] },    // #FF9900
    { value: 0.95, color: [255, 61, 0] },     // #FF3D00
    { value: 1.00, color: [179, 0, 0] }       // #B30000 - darkest red
  ];

  // Find the two color stops to interpolate between
  let lowerStop = colorStops[0];
  let upperStop = colorStops[colorStops.length - 1];

  for (let i = 0; i < colorStops.length - 1; i++) {
    if (normalizedValue >= colorStops[i].value && normalizedValue <= colorStops[i + 1].value) {
      lowerStop = colorStops[i];
      upperStop = colorStops[i + 1];
      break;
    }
  }

  // Interpolate between the two stops
  const colorRange = upperStop.value - lowerStop.value;
  const t = colorRange === 0 ? 0 : (normalizedValue - lowerStop.value) / colorRange;

  const r = Math.round(lowerStop.color[0] + (upperStop.color[0] - lowerStop.color[0]) * t);
  const g = Math.round(lowerStop.color[1] + (upperStop.color[1] - lowerStop.color[1]) * t);
  const b = Math.round(lowerStop.color[2] + (upperStop.color[2] - lowerStop.color[2]) * t);

  // Validate color values to prevent NaN
  const validR = isNaN(r) ? 107 : Math.max(0, Math.min(255, r));
  const validG = isNaN(g) ? 114 : Math.max(0, Math.min(255, g));
  const validB = isNaN(b) ? 128 : Math.max(0, Math.min(255, b));
  const validOpacity = isNaN(opacity) ? 0.2 : Math.max(0, Math.min(1, opacity));

  if (isNaN(r) || isNaN(g) || isNaN(b)) {
    console.warn(`[Choropleth] NaN color values detected: r=${r}, g=${g}, b=${b}, count=${count}, normalizedValue=${normalizedValue}, scale=${JSON.stringify(scale)}`);
  }

  return `rgba(${validR}, ${validG}, ${validB}, ${validOpacity})`;
}

/**
 * Create a MapLibre expression for choropleth coloring
 */
export function createChoroplethExpression(
  choroplethData: ChoroplethData,
  regionIdField: string,
  opacity: number = 0.2
): unknown {
  const { neighborhoods, scale } = choroplethData;
  
  // Default color for neighborhoods without data
  const defaultColor = `rgba(107, 114, 128, ${opacity * 0.3})`;
  
  // If no neighborhoods, return a proper MapLibre expression with default color
  if (!neighborhoods || neighborhoods.length === 0) {
    return ['literal', defaultColor];
  }
  
  // Build MapLibre case expression - each case needs condition, then result
  const cases: unknown[] = [];
  
  neighborhoods.forEach(({ regionId, count }) => {
    const color = getChoroplethColor(count, scale, opacity);
    // Add condition and result as separate elements
    cases.push(['==', ['get', regionIdField], regionId]);
    cases.push(color);
  });

  return [
    'case',
    ...cases,
    defaultColor // fallback for regions not in choropleth data
  ];
}

/**
 * Get the region ID from a neighborhood feature based on city
 */
export function getRegionIdFromFeature(
  feature: GeoJSON.Feature,
  city: 'nyc' | 'sf'
): string | null {
  const props = feature.properties || {};
  
  if (city === 'nyc') {
    // Try different NYC field names
    return props.NTA2020 || props.ntacode || props.nta2020 || props.ntaname || null;
  } else if (city === 'sf') {
    // Try different SF field names
    return props.name || props.nhood || props.analysis_neighborhood || null;
  }
  
  return null;
}

/**
 * Create a legend for the choropleth colors
 */
export function createChoroplethLegend(scale: ChoroplethData['scale']): Array<{
  label: string;
  color: string;
  range: string;
}> {
  return [
    {
      label: 'Very Low',
      color: getChoroplethColor(scale.min, scale, 1),
      range: `${scale.min} - ${Math.round(scale.p50 * 0.5)}`
    },
    {
      label: 'Low',
      color: getChoroplethColor(scale.p50 * 0.75, scale, 1),
      range: `${Math.round(scale.p50 * 0.5)} - ${scale.p50}`
    },
    {
      label: 'Medium',
      color: getChoroplethColor(scale.p50 * 1.5, scale, 1),
      range: `${scale.p50} - ${scale.p90}`
    },
    {
      label: 'High',
      color: getChoroplethColor(scale.p90 * 1.1, scale, 1),
      range: `${scale.p90} - ${scale.p99}`
    },
    {
      label: 'Very High',
      color: getChoroplethColor(scale.max, scale, 1),
      range: `${scale.p99}+`
    }
  ];
}
