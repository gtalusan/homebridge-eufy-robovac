import type { API, ClusterStateMap, EndpointType, Logging, MatterAccessory } from 'homebridge';

export interface BaseMatterAccessoryConfig {
  UUID: string;
  displayName: string;
  deviceType: EndpointType;
  serialNumber: string;
  manufacturer: string;
  model: string;
  firmwareRevision: string;
  hardwareRevision: string;
  context?: Record<string, unknown>;
  clusters?: MatterAccessory['clusters'];
  handlers?: MatterAccessory['handlers'];
  parts?: MatterAccessory['parts'];
}

export abstract class BaseMatterAccessory implements MatterAccessory {
  public readonly UUID: string;
  public readonly displayName: string;
  public readonly deviceType: EndpointType;
  public readonly serialNumber: string;
  public readonly manufacturer: string;
  public readonly model: string;
  public readonly firmwareRevision: string;
  public readonly hardwareRevision: string;
  public readonly context: Record<string, unknown>;
  public readonly clusters?: MatterAccessory['clusters'];
  public readonly handlers?: MatterAccessory['handlers'];
  public readonly parts?: MatterAccessory['parts'];

  protected readonly api: API;
  protected readonly log: Logging;
  private matterReady = false;

  protected constructor(
    api: API,
    log: Logging,
    config: BaseMatterAccessoryConfig,
  ) {
    this.api = api;
    this.log = log;

    this.UUID = config.UUID;
    this.displayName = config.displayName;
    this.deviceType = config.deviceType;
    this.serialNumber = config.serialNumber;
    this.manufacturer = config.manufacturer;
    this.model = config.model;
    this.firmwareRevision = config.firmwareRevision;
    this.hardwareRevision = config.hardwareRevision;
    this.clusters = config.clusters;
    this.handlers = config.handlers;
    this.parts = config.parts;

    this.context = {
      serialNumber: this.serialNumber,
      manufacturer: this.manufacturer,
      model: this.model,
      firmwareRevision: this.firmwareRevision,
      hardwareRevision: this.hardwareRevision,
      ...config.context,
    };
  }

  protected async updateState<K extends keyof ClusterStateMap>(cluster: K, attributes: Partial<ClusterStateMap[K]>, partId?: string): Promise<void>;
  protected async updateState(cluster: string, attributes: Record<string, unknown>, partId?: string): Promise<void>;
  protected async updateState(cluster: string, attributes: Record<string, unknown>, partId?: string): Promise<void> {
    if (!this.matterReady) {
      this.log.debug(`[${this.displayName}] Matter not ready, skipping ${cluster} state update`);
      return;
    }
    await this.api.matter.updateAccessoryState(this.UUID, cluster, attributes, partId);
    this.log.debug(`[${this.displayName}] Updated ${cluster} state:`, JSON.stringify(attributes));
  }

  public setMatterReady(): void {
    this.matterReady = true;
  }

  protected async readState<K extends keyof ClusterStateMap>(cluster: K, partId?: string): Promise<Partial<ClusterStateMap[K]> | undefined>;
  protected async readState(cluster: string, partId?: string): Promise<Record<string, unknown> | undefined>;
  protected async readState(cluster: string, partId?: string): Promise<Record<string, unknown> | undefined> {
    return await this.api.matter.getAccessoryState(this.UUID, cluster, partId);
  }

  protected logInfo(message: string, ...args: unknown[]): void {
    this.log.info(`[${this.displayName}] ${message}`, ...args);
  }

  protected logError(message: string, ...args: unknown[]): void {
    this.log.error(`[${this.displayName}] ${message}`, ...args);
  }

  protected logDebug(message: string, ...args: unknown[]): void {
    this.log.debug(`[${this.displayName}] ${message}`, ...args);
  }

  protected logWarn(message: string, ...args: unknown[]): void {
    this.log.warn(`[${this.displayName}] ${message}`, ...args);
  }

  public toAccessory(): MatterAccessory {
    return {
      UUID: this.UUID,
      displayName: this.displayName,
      deviceType: this.deviceType,
      serialNumber: this.serialNumber,
      manufacturer: this.manufacturer,
      model: this.model,
      firmwareRevision: this.firmwareRevision,
      hardwareRevision: this.hardwareRevision,
      context: this.context,
      clusters: this.clusters,
      handlers: this.handlers,
      parts: this.parts,
    };
  }
}
