// Transform StatsResponse from API to legacy format expected by Sidebar
import type { StatsResponse } from '@/types/api';
import type { PairsMode } from '@/types/crime';

// Legacy stats format expected by Sidebar
export interface LegacyStats {
  total: number;
  ofnsTop: Array<{ label: string; count: number }>;
  byPremises?: Array<{ label: string; count: number }>;
  byRace?: Array<{ label: string; count: number }>;
  byAge?: Array<{ label: string; count: number }>;
  byType: { [key: string]: number };
}

// Chart series format for monthly data (matches Sidebar BarChart expectations)
export interface MonthlyData {
  month: string;
  count: number;
  label?: string;
}

// Pairs data format
export interface PairsData {
  label: string;
  count: number;
  tooltip?: string;
}

// Trend stats format
export interface TrendStats {
  avgMonthlyPct: number;
  line: Array<{ month: string; count: number }>;
  trend: "up" | "down" | "stable";
  percentage: number;
}

/**
 * Clean and consolidate demographic categories
 */
function cleanDemographicData(data: Array<{ category: string; count: number }>): Array<{ label: string; count: number }> {
  const consolidated = new Map<string, number>();
  
  for (const item of data) {
    let category = item.category;
    
    // Consolidate null and unknown values
    if (category === '(null)' || category === 'UNKNOWN' || category === '') {
      category = 'UNKNOWN';
    }
    
    // Consolidate invalid age values
    if (category === '1022' || category === '1023' || category === '2022' || category === '-2' || category === '-961' || category === '-964') {
      category = 'UNKNOWN';
    }
    
    const current = consolidated.get(category) || 0;
    consolidated.set(category, current + item.count);
  }
  
  // Convert back to array and sort by count
  return Array.from(consolidated.entries())
    .map(([label, count]) => ({ label, count }))
    .sort((a, b) => b.count - a.count);
}

/**
 * Transform StatsResponse to legacy format for Sidebar
 */
export function transformStatsResponse(response: StatsResponse): LegacyStats {
  // Transform offense breakdown to legacy format
  const ofnsTop = response.byOffense.map(item => ({
    label: item.offense,
    count: item.count
  }));

  // Transform location breakdown to premises format - consolidate null values
  const locationMap = new Map<string, number>();
  for (const item of response.byLocation) {
    let location = item.location;
    // Clean up premise descriptions
    if (location === '(null)' || location === '' || location === 'null') {
      location = 'UNKNOWN';
    }
    // Clean up common premise type variations
    location = location.trim().toUpperCase();
    
    const current = locationMap.get(location) || 0;
    locationMap.set(location, current + item.count);
  }
  
  const byPremises = Array.from(locationMap.entries())
    .map(([label, count]) => ({ label, count }))
    .sort((a, b) => b.count - a.count);

  // Transform demographics if available (NYC only) - clean and consolidate
  let byRace, byAge;
  if (response.demographics?.susp.race) {
    byRace = cleanDemographicData(response.demographics.susp.race);
  }
  if (response.demographics?.susp.age) {
    byAge = cleanDemographicData(response.demographics.susp.age);
  }

  // Create byType lookup for backward compatibility
  const byType: { [key: string]: number } = {};
  response.byOffense.forEach(item => {
    byType[item.offense] = item.count;
  });

  return {
    total: response.totals.events,
    ofnsTop,
    byPremises: byPremises.length > 0 ? byPremises : undefined,
    byRace: byRace && byRace.length > 0 ? byRace : undefined,
    byAge: byAge && byAge.length > 0 ? byAge : undefined,
    byType
  };
}

/**
 * Transform time series data to chart format
 */
export function transformTimeSeriesData(response: StatsResponse): MonthlyData[] {
  return response.timeSeries.map(item => ({
    month: item.month,
    count: item.count,
    label: formatMonthLabel(item.month)
  }));
}

/**
 * Transform demographics pairs data based on mode
 */
export function transformPairsData(response: StatsResponse, mode: PairsMode): PairsData[] {
  if (!response.demographics?.pairs) {
    return [];
  }

  const pairs = response.demographics.pairs;

  switch (mode) {
    case 'race':
      return pairs.suspVicRace.map(item => ({
        label: `${item.suspRace} → ${item.vicRace}`,
        count: item.count,
        tooltip: `Suspect: ${item.suspRace}, Victim: ${item.vicRace}`
      }));

    case 'sex':
      return pairs.suspVicSex.map(item => ({
        label: `${item.suspSex} → ${item.vicSex}`,
        count: item.count,
        tooltip: `Suspect: ${item.suspSex}, Victim: ${item.vicSex}`
      }));

    case 'both':
      return pairs.suspVicBoth.map(item => ({
        label: `${item.suspRace} ${item.suspSex} → ${item.vicRace} ${item.vicSex}`,
        count: item.count,
        tooltip: `Suspect: ${item.suspRace} ${item.suspSex}, Victim: ${item.vicRace} ${item.vicSex}`
      }));

    default:
      return [];
  }
}

/**
 * Calculate trend statistics from time series data
 */
export function calculateTrendStats(timeSeries: MonthlyData[]): TrendStats | null {
  if (timeSeries.length < 2) {
    return null;
  }

  // Calculate simple linear trend
  const counts = timeSeries.map(item => item.count);
  const n = counts.length;
  
  // Calculate slope using least squares
  let sumX = 0, sumY = 0, sumXY = 0, sumXX = 0;
  
  for (let i = 0; i < n; i++) {
    sumX += i;
    sumY += counts[i];
    sumXY += i * counts[i];
    sumXX += i * i;
  }
  
  const slope = (n * sumXY - sumX * sumY) / (n * sumXX - sumX * sumX);
  const intercept = (sumY - slope * sumX) / n;
  
  // Generate trend line
  const line = timeSeries.map((item, i) => ({
    month: item.month,
    count: slope * i + intercept
  }));
  
  // Calculate average monthly percentage change
  const avgCount = sumY / n;
  const avgMonthlyPct = avgCount > 0 ? (slope / avgCount) * 100 : 0;
  
  // Determine trend direction
  let trend: "up" | "down" | "stable" = "stable";
  if (Math.abs(avgMonthlyPct) > 1) { // Only consider significant changes
    trend = avgMonthlyPct > 0 ? "up" : "down";
  }
  
  return {
    avgMonthlyPct,
    line,
    trend,
    percentage: Math.abs(avgMonthlyPct)
  };
}

/**
 * Format month label for display
 */
function formatMonthLabel(monthString: string): string {
  const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", 
                     "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  
  const parts = monthString.split('-');
  if (parts.length !== 2) return monthString;
  
  const year = parseInt(parts[0]);
  const month = parseInt(parts[1]);
  
  if (isNaN(year) || isNaN(month) || month < 1 || month > 12) {
    return monthString;
  }
  
  return `${monthNames[month - 1]} ${String(year).slice(2)}`;
}

/**
 * Check if stats data is valid and complete
 */
export function isValidStatsData(stats: LegacyStats | null): boolean {
  return !!(
    stats &&
    typeof stats.total === 'number' &&
    Array.isArray(stats.ofnsTop)
    // Allow empty ofnsTop for neighborhood filtering
  );
}

/**
 * Get empty stats object for loading states
 */
export function getEmptyStats(): LegacyStats {
  return {
    total: 0,
    ofnsTop: [],
    byType: {}
  };
}
