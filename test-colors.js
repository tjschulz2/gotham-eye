// Quick test of choropleth colors
const scale = {
  min: 267,
  max: 3509,
  p50: 527,
  p90: 1600,
  p99: 3509
};

function getChoroplethColor(count, scale, opacity = 0.7) {
  if (count === 0) {
    return `rgba(107, 114, 128, ${opacity})`; // Gray for no data
  }

  // Normalize the count to a 0-1 scale using percentiles
  let normalizedValue;
  
  if (count <= scale.p50) {
    // Low crime: 0 to 0.5 (blue to light blue)
    normalizedValue = (count - scale.min) / (scale.p50 - scale.min) * 0.5;
  } else if (count <= scale.p90) {
    // Medium crime: 0.5 to 0.8 (light blue to orange)
    normalizedValue = 0.5 + (count - scale.p50) / (scale.p90 - scale.p50) * 0.3;
  } else {
    // High crime: 0.8 to 1.0 (orange to red)
    normalizedValue = 0.8 + (count - scale.p90) / (scale.max - scale.p90) * 0.2;
  }

  // Clamp to 0-1 range
  normalizedValue = Math.max(0, Math.min(1, normalizedValue));

  // Generate color based on normalized value
  let r, g, b;

  if (normalizedValue < 0.5) {
    // Blue to light blue/cyan (low crime)
    const t = normalizedValue * 2; // 0 to 1
    r = Math.round(30 + t * 70);   // 30 to 100
    g = Math.round(144 + t * 50);  // 144 to 194
    b = Math.round(255 - t * 55);  // 255 to 200
  } else if (normalizedValue < 0.8) {
    // Light blue to orange (medium crime)
    const t = (normalizedValue - 0.5) / 0.3; // 0 to 1
    r = Math.round(100 + t * 155); // 100 to 255
    g = Math.round(194 - t * 29);  // 194 to 165
    b = Math.round(200 - t * 200); // 200 to 0
  } else {
    // Orange to red (high crime)
    const t = (normalizedValue - 0.8) / 0.2; // 0 to 1
    r = 255;                       // Stay at 255
    g = Math.round(165 - t * 165); // 165 to 0
    b = 0;                         // Stay at 0
  }

  return `rgba(${r}, ${g}, ${b}, ${opacity})`;
}

// Test different crime levels
console.log('Low crime (267):', getChoroplethColor(267, scale));
console.log('Medium crime (527):', getChoroplethColor(527, scale));
console.log('High crime (1600):', getChoroplethColor(1600, scale));
console.log('Very high crime (3509):', getChoroplethColor(3509, scale));
