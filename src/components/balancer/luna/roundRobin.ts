import { Name } from "src/common/name";
import { ServiceInfo } from "src/common/serviceInfo";
import { TOKENS } from "src/di";
import { LoggerModule } from "src/modules/logger/types";
import { ServiceModule } from "src/modules/service/types";
import { autoInjectable, inject } from "tsyringe";
import { LoadBalancer, LoadBalancerError } from "../types";

export type RoundRobinServiceData = {
    serviceName: Name,
    currentIndex: number
}

@autoInjectable()
export class LunaRoundRobinBalancer implements LoadBalancer {
    private _servicesData: RoundRobinServiceData[];

    constructor(
        @inject(TOKENS.modules.service) private serviceModule?: ServiceModule,
        @inject(TOKENS.modules.logger) private logger?: LoggerModule
    ) {
        this._servicesData = [];
        this.logger?.log("Load Balancer loaded with Round Robin method.");
    }

    balanceService(serviceName: Name): Promise<ServiceInfo> {
        return new Promise(async (resolve, reject) => {
            const serviceInstances = await this.serviceModule?.findAllByName(serviceName);

            if (serviceInstances == null || serviceInstances && serviceInstances.length <= 0) {
                return new LoadBalancerError("Service does not have any instances registered.");
            }

            /**
             * Service only has one instance for it, no balancing required.
             * Return the only instance.
             */
            if (serviceInstances.length === 1) {
                this.logger?.log("RoundRobinModule: Only one instance in list");
                return resolve(serviceInstances[0]);
            }

            const serviceDataIndex = this._servicesData.findIndex(service => service.serviceName.equals(serviceName));
            
            if (serviceDataIndex < 0) {
                this._servicesData.push({
                    serviceName: serviceName,
                    currentIndex: 0
                });

                return resolve(serviceInstances[0]);
            }

            if (this._servicesData[serviceDataIndex].currentIndex + 1 >= serviceInstances.length) {
                this._servicesData[serviceDataIndex].currentIndex = 0;
            } else {
                this._servicesData[serviceDataIndex].currentIndex++;
            }

            
            return resolve(serviceInstances[this._servicesData[serviceDataIndex].currentIndex]);
        });
    }
}