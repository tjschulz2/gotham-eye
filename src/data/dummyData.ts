import type { CrimeType } from "@/types/crime";
import type { Stats, ChartSeries, TrendStats } from "@/hooks/useDataState";

export const dummyCrimeTypes: CrimeType[] = [
  { label: "MURDER & NON-NEGL. MANSLAUGHTER", count: 100 },
  { label: "RAPE", count: 200 },
  { label: "ROBBERY", count: 300 },
  { label: "FELONY ASSAULT", count: 400 },
  { label: "BURGLARY", count: 500 },
  { label: "GRAND LARCENY", count: 600 },
  { label: "PETIT LARCENY", count: 700 },
  { label: "CRIMINAL MISCHIEF", count: 800 }
];

export const dummyStats: Stats = {
  total: 3600,
  byType: {
    "MURDER & NON-NEGL. MANSLAUGHTER": 100,
    "RAPE": 200,
    "ROBBERY": 300,
    "FELONY ASSAULT": 400,
    "BURGLARY": 500,
    "GRAND LARCENY": 600,
    "PETIT LARCENY": 700,
    "CRIMINAL MISCHIEF": 800
  }
};

export const dummyChartSeries: ChartSeries[] = [
  {
    name: "Violent Crimes",
    data: [10, 20, 30, 25, 35, 45, 40, 50, 45, 55, 50, 60]
  },
  {
    name: "Non-violent Crimes",
    data: [50, 60, 70, 65, 75, 85, 80, 90, 85, 95, 90, 100]
  }
];

export const dummyTrendStats: TrendStats = {
  avgMonthlyPct: 5.2,
  line: [10, 12, 15, 18, 22, 25, 30],
  trend: "up",
  percentage: 15.3
};

// Function to initialize all dummy data at once
export function initializeDummyData(dataState: any) {
  dataState.setCrimeTypes(dummyCrimeTypes);
  dataState.setStats(dummyStats);
  dataState.setChartSeries(dummyChartSeries);
  dataState.setTrendStats(dummyTrendStats);
}
