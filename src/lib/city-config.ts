export type CityId = 'nyc' | 'sf';

export interface FilterCategory {
  id: string;
  label: string;
  offenses: string[];
}

export interface CityConfig {
  id: CityId;
  name: string;
  displayName: string;
  center: [number, number]; // [lng, lat]
  zoom: number;
  boundariesFile: string;
  hasDemographics: boolean;
  hasLawClass: boolean;
  offenseField: string;
  defaultYears: [number, number];
  dataSources: string[];
  
  // City-specific methods
  getFilterCategories: () => FilterCategory[];
}

// NYC Configuration
const nycConfig: CityConfig = {
  id: 'nyc',
  name: 'nyc',
  displayName: 'New York City',
  center: [-73.99, 40.7328],
  zoom: 12.5,
  boundariesFile: '/nyc_nta_2020.geojson',
  hasDemographics: true,
  hasLawClass: true,
  offenseField: 'offense',
  defaultYears: [2022, new Date().getFullYear()],
  dataSources: [
    'https://data.cityofnewyork.us/Public-Safety/NYPD-Complaint-Data-Historic/qgea-i56i/about_data',
    'https://data.cityofnewyork.us/Public-Safety/NYPD-Complaint-Data-Current-Year-To-Date-/5uac-w243/about_data',
    'https://data.cityofnewyork.us/Public-Safety/NYPD-Shooting-Incident-Data-Historic-/833y-fsy8/about_data',
    'https://data.cityofnewyork.us/Public-Safety/NYPD-Shooting-Incident-Data-Year-To-Date-/5ucz-vwe8/about_data',
  ],
  
  // Removed violent/nonviolent categorization - let database return raw offense names
  getFilterCategories: (): FilterCategory[] => [],
  
};

// SF Configuration  
const sfConfig: CityConfig = {
  id: 'sf',
  name: 'sf',
  displayName: 'San Francisco',
  center: [-122.4194, 37.7749],
  zoom: 12.5,
  boundariesFile: '/sf_nta_2025.geojson',
  hasDemographics: false,
  hasLawClass: false,
  offenseField: 'offense',
  defaultYears: [2022, new Date().getFullYear()],
  dataSources: [
    'https://data.sfgov.org/Public-Safety/Police-Department-Incident-Reports-2018-to-Present/wg3w-h783/about_data',
    'https://data.sfgov.org/Public-Safety/Police-Department-Incident-Reports-Historical-2003/tmnf-yvry/about_data',
  ],
  
  // Removed violent/nonviolent categorization - let database return raw offense names
  getFilterCategories: (): FilterCategory[] => [],
  
};

export const CITY_CONFIGS: Record<CityId, CityConfig> = {
  nyc: nycConfig,
  sf: sfConfig
};

export function getCityConfig(cityId: CityId): CityConfig {
  return CITY_CONFIGS[cityId];
}

export function getAllCityConfigs(): CityConfig[] {
  return Object.values(CITY_CONFIGS);
}
