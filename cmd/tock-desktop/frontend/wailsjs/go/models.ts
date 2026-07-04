export namespace models {
	
	export class Activity {
	    description: string;
	    project: string;
	    // Go type: time
	    start_time: any;
	    // Go type: time
	    end_time?: any;
	    notes?: string;
	    tags?: string[];
	
	    static createFrom(source: any = {}) {
	        return new Activity(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.description = source["description"];
	        this.project = source["project"];
	        this.start_time = this.convertValues(source["start_time"], null);
	        this.end_time = this.convertValues(source["end_time"], null);
	        this.notes = source["notes"];
	        this.tags = source["tags"];
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}

}

export namespace neonauth {
	
	export class Status {
	    configured: boolean;
	    signed_in: boolean;
	    user_id?: string;
	    email?: string;
	    name?: string;
	
	    static createFrom(source: any = {}) {
	        return new Status(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.configured = source["configured"];
	        this.signed_in = source["signed_in"];
	        this.user_id = source["user_id"];
	        this.email = source["email"];
	        this.name = source["name"];
	    }
	}

}

export namespace teams {
	
	export class Status {
	    connected: boolean;
	    user_upn?: string;
	    tenant_id?: string;
	    expires_unix?: number;
	    missing_tokens?: string[];
	    enabled: boolean;
	    tracked_projects: string[];
	
	    static createFrom(source: any = {}) {
	        return new Status(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.connected = source["connected"];
	        this.user_upn = source["user_upn"];
	        this.tenant_id = source["tenant_id"];
	        this.expires_unix = source["expires_unix"];
	        this.missing_tokens = source["missing_tokens"];
	        this.enabled = source["enabled"];
	        this.tracked_projects = source["tracked_projects"];
	    }
	}

}

