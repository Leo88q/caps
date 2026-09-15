/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_CLUSTER?: string;
  readonly VITE_RPC_URL?: string;
  readonly VITE_RPC_WS_URL?: string;
  readonly VITE_API_BASE?: string;
  readonly VITE_WS_BASE?: string;
  readonly VITE_DEV_API_TARGET?: string;
  readonly VITE_FLAG_GEO_GATE?: string;
  readonly VITE_FLAG_LIMITED_PACK?: string;
  readonly VITE_FLAG_DEBUG_PANEL?: string;
  readonly VITE_API_MOCK?: string;
  readonly VITE_ONRAMP_URL?: string;
  readonly VITE_PROGRAM_CHIP_CORE?: string;
  readonly VITE_PROGRAM_MARKET?: string;
  readonly VITE_PROGRAM_STAKING?: string;
  readonly VITE_PROGRAM_ARENA?: string;
  readonly VITE_CG_MINT?: string;
  readonly VITE_USDC_MINT?: string;
  readonly VITE_SKR_MINT?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
