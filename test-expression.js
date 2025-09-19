// Test MapLibre expression format
const choroplethData = {
  neighborhoods: [
    { regionId: 'MN0501', count: 2157 },
    { regionId: 'QN0707', count: 1946 },
    { regionId: 'BK0101', count: 1234 }
  ],
  scale: {
    min: 267,
    max: 3509,
    p50: 527,
    p90: 1600,
    p99: 3509
  }
};

function getChoroplethColor(count, scale, opacity = 0.7) {
  if (count === 0) {
    return `rgba(107, 114, 128, ${opacity})`;
  }

  let normalizedValue;
  
  if (count <= scale.p50) {
    normalizedValue = (count - scale.min) / (scale.p50 - scale.min) * 0.5;
  } else if (count <= scale.p90) {
    normalizedValue = 0.5 + (count - scale.p50) / (scale.p90 - scale.p50) * 0.3;
  } else {
    normalizedValue = 0.8 + (count - scale.p90) / (scale.max - scale.p90) * 0.2;
  }

  normalizedValue = Math.max(0, Math.min(1, normalizedValue));

  let r, g, b;

  if (normalizedValue < 0.5) {
    const t = normalizedValue * 2;
    r = Math.round(30 + t * 70);
    g = Math.round(144 + t * 50);
    b = Math.round(255 - t * 55);
  } else if (normalizedValue < 0.8) {
    const t = (normalizedValue - 0.5) / 0.3;
    r = Math.round(100 + t * 155);
    g = Math.round(194 - t * 29);
    b = Math.round(200 - t * 200);
  } else {
    const t = (normalizedValue - 0.8) / 0.2;
    r = 255;
    g = Math.round(165 - t * 165);
    b = 0;
  }

  return `rgba(${r}, ${g}, ${b}, ${opacity})`;
}

function createChoroplethExpression(choroplethData, regionIdField, opacity = 0.7) {
  const { neighborhoods, scale } = choroplethData;
  
  const cases = [];
  
  neighborhoods.forEach(({ regionId, count }) => {
    const color = getChoroplethColor(count, scale, opacity);
    cases.push(['==', ['get', regionIdField], regionId]);
    cases.push(color);
  });

  const defaultColor = `rgba(107, 114, 128, ${opacity * 0.3})`;

  return [
    'case',
    ...cases,
    defaultColor
  ];
}

const expression = createChoroplethExpression(choroplethData, 'NTA2020', 0.6);
console.log('MapLibre Expression:');
console.log(JSON.stringify(expression, null, 2));
