import { NginxConfFile } from "nginx-conf";
import { NginxConfItem } from "nginx-conf/dist/src/conf";
import EventEmitter from "node:events";
import TypedEmitter from "typed-emitter"
import { inject, injectable } from "tsyringe";
import { NginxConfigContext, NginxConfigDirective, NginxConfigModule, NginxConfigModuleError, NginxConfigContextEvents } from "./types";
import { ServiceInfo } from "../../common/serviceInfo";

export class NginxConfModuleContext extends (EventEmitter as new () => TypedEmitter<NginxConfigContextEvents>) implements NginxConfigContext {
    private _context: NginxConfItem;
    readonly name: string;
    readonly value: string | number;
    
    constructor(context: NginxConfItem) {
        super();
        this.name = context._name;
        this.value = context._value;
        this._context = context;
    }
    

    getContexts(name: string): NginxConfigContext[] {
        const foundContexts = this._context[name];

        if (foundContexts != null) {
            return foundContexts.map(context => new NginxConfModuleContext(context));
        }

        return [];
    }

    addContext(name: string, value: string): NginxConfigContext {
        const updateContext =  new NginxConfModuleContext(this._context._add(name, value));

        this.emit('update', updateContext);

        return updateContext;
    }

    addComment(comment: string): NginxConfigContext {
       this._context._comments.push(comment);

       this.emit('update', this);

       return this;
    }

    getComments(): string[] {
        return this._context._comments;
    }

    addDirective(directive: NginxConfigDirective): NginxConfigContext {
        const addContext = new NginxConfModuleContext(this._context._add(directive.name, directive.params.join(" ")));

        this.emit('update', addContext);

        return addContext;
    }

    getDirectives(name: string): NginxConfigDirective[] | undefined {
        const foundDirective = this._context[name];

        if (foundDirective) {
            return foundDirective.map(directive => 
                ({name: directive._name, params: (typeof(directive) == 'number' && [directive]) || 
                (directive._value as string).split(" ")} as NginxConfigDirective)
            )
        }

        return undefined;
    }

    editDirective(directiveToEdit: NginxConfigDirective, changes: NginxConfigDirective): NginxConfigContext | undefined {
        const directiveFoundIndex = this._context[directiveToEdit.name]
                                   ?.findIndex(v => v._value === directiveToEdit.params.join(" "));
        
        if (directiveFoundIndex !== -1) {
            const contexts = this._context[directiveToEdit.name] as NginxConfItem[];
            contexts[(directiveFoundIndex as number)]._value = changes.params.join(" ");
            return new NginxConfModuleContext(this._context);
        }
    }
}

@injectable()
export class NginxConfModule implements NginxConfigModule {
    private _rootContext: NginxConfigContext | undefined;
    private _serverContext: NginxConfigContext | undefined;
    private conf: NginxConfFile | undefined;

    constructor(
        @inject("NginxConf") private nginxConf: typeof NginxConfFile,
        @inject("PathToNginxConfigFile") private nginxConfigFilePath: string
    ) {
        /**
         * Sets root context
         */
        this.getRootContext();
    }
    

    getRootContext(): Promise<NginxConfigContext> {
        return new Promise((resolve, reject) => {
            this.nginxConf.create(this.nginxConfigFilePath, (err, conf) => {
                if (err || !conf) {
                    throw (err || new NginxConfigModuleError(`Could not set up NgixConf at file path '${this.nginxConfigFilePath}'`));
                }

                if (this._rootContext != null) {
                    return resolve(this._rootContext);
                }
    
                this._rootContext = new NginxConfModuleContext(conf.nginx);

                this.conf = conf;

                return resolve(this._rootContext);
            });
        });
    }

    getContexts(name: string, parentContext?: NginxConfigContext): NginxConfigContext[] | undefined {
        if (parentContext != null) {
            return parentContext.getContexts(name);
        }

        return this._rootContext?.getContexts(name);
    }

    addContext(name: string, value: string, parentContext?: NginxConfigContext): NginxConfigContext {
        if (parentContext != null) {
            return parentContext.addContext(name, value);
        }

        const addedContext =  this._rootContext?.addContext(name, value);
        
        if (addedContext) {
            return addedContext;
        }

        throw new NginxConfigModuleError(`Could not add context '${name}'`);
    }


    async getServerContext(): Promise<NginxConfigContext | undefined> {
        if (await this.getRootContext() == null) {
            throw new NginxConfigModuleError("Root context could not be found in the nginx config path.");
        }

        let serverContext;

        const rootServers = this.getContexts('server');
        
        if (rootServers && rootServers.length > 0) {

            serverContext = rootServers[0]
        } else {
            const httpContext = this.getContexts('http');
            serverContext = httpContext && 
                   httpContext.find(context => context.getContexts('server').length > 0)
                   ?.getContexts('server')[0];
        }

        this._serverContext = serverContext;


        return Promise.resolve(serverContext);
    }

    getServiceLocationContext(serviceInfo: ServiceInfo): NginxConfigContext | undefined {
        const serviceName = serviceInfo.raw().name;
        const servicePath = '/api/' + serviceName;
        let serviceLocationContext = this._serverContext?.getContexts('location')
                                                         .find(context => context.value === servicePath);
    
        if (serviceLocationContext == null) {
            serviceLocationContext = this._serverContext?.addContext('location', servicePath)
                        .getContexts('location')
                        .find(context => context.value === servicePath);
        }

        if (serviceLocationContext?.getComments().length as number < 1) {
            serviceLocationContext?.addComment("Managed By Luna");
        }

        const serviceRewriteRuleDirectiveExists = serviceLocationContext?.getDirectives('rewrite')?.length as number > 0;

        if (!serviceRewriteRuleDirectiveExists) {
            serviceLocationContext?.addDirective({
                name: "rewrite", 
                params: [`/api/${serviceName}/(.*)`, "/$1", "break"]
            });
        }

        const serviceLocationDirectiveExists = serviceLocationContext?.getDirectives('proxy_pass')
                                                                      ?.some(directive => directive.params[0] === `http://${this.getServiceUpstreamKey(serviceInfo)}`)
        if (!serviceLocationDirectiveExists) {
            serviceLocationContext?.addDirective({
                name: "proxy_pass", 
                params: [`http://${this.getServiceUpstreamKey(serviceInfo)}`]
            });
        }


        return serviceLocationContext;
    }

    getServiceUpstreamContext(serviceInfo: ServiceInfo): NginxConfigContext | undefined {
        let serviceUpstreamContext = this.getContexts('upstream')
                                         ?.find(context => context.value === this.getServiceUpstreamKey(serviceInfo));
        
        if (serviceUpstreamContext == null) {
            serviceUpstreamContext = this.addContext('upstream', this.getServiceUpstreamKey(serviceInfo))
                                         .getContexts('upstream')
                                         .find(context => context.value === this.getServiceUpstreamKey(serviceInfo));
        }                                                   

        if (serviceUpstreamContext?.getComments().length as number < 1) {
            serviceUpstreamContext?.addComment("Managed By Luna");
        }

        serviceUpstreamContext?.on('update', this.flush);
        return serviceUpstreamContext;
    }

    getServiceUpstreamKey(serviceInfo: ServiceInfo): string {
        return `luna_service_${serviceInfo.raw().name}`;
    }

    private flush(): Promise<void> {
        return new Promise(async (resolve, reject) => {
            console.log("FLUSHED");
            this.conf?.flush((err) => {
                if (err) throw err;

                return resolve();
            })
        })
    }
}

