import type { WaitStrategy } from "testcontainers";

export type PortRange = readonly [min: number, max: number];

export interface PortDecl {
  container: number;
  range?: PortRange;
}

export interface ServiceDecl {
  image: string;
  ports?: PortDecl[];
  env?: Record<string, string>;
  waitFor?: WaitStrategy;
}

export type ServiceOptions = ServiceDecl;

export interface StackDecl {
  services: Record<string, ServiceDecl>;
  defaultRange?: PortRange;
  env?: Record<string, string>;
}

export interface ServicePortMapping {
  container: number;
  host: number;
}

export interface ServiceMapping {
  service: string;
  host: string;
  ports: ServicePortMapping[];
}

export interface UpOptions {
  defaultRange?: PortRange;
}

export interface StackHandle {
  up(opts?: UpOptions): Promise<Record<string, string>>;
  down(): Promise<void>;
  readonly env: Record<string, string> | undefined;
  hostPort(service: string, containerPort: number): number;
  mappings(): ServiceMapping[];
}
