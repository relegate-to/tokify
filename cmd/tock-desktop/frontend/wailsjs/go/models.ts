export namespace main {
	
	export class SharedActivity {
	    activity: models.Activity;
	    audience_id: string;
	    team_name: string;
	    author_id: string;
	    author_name: string;
	
	    static createFrom(source: any = {}) {
	        return new SharedActivity(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.activity = this.convertValues(source["activity"], models.Activity);
	        this.audience_id = source["audience_id"];
	        this.team_name = source["team_name"];
	        this.author_id = source["author_id"];
	        this.author_name = source["author_name"];
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
	export class TeamView {
	    ID: string;
	    Role: string;
	    MemberCount: number;
	    CurrentEpoch: number;
	    Pending: boolean;
	    InvitedBy: string;
	    SharedName: string;
	    Members: neonsync.TeamMember[];
	    Name: string;
	
	    static createFrom(source: any = {}) {
	        return new TeamView(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.ID = source["ID"];
	        this.Role = source["Role"];
	        this.MemberCount = source["MemberCount"];
	        this.CurrentEpoch = source["CurrentEpoch"];
	        this.Pending = source["Pending"];
	        this.InvitedBy = source["InvitedBy"];
	        this.SharedName = source["SharedName"];
	        this.Members = this.convertValues(source["Members"], neonsync.TeamMember);
	        this.Name = source["Name"];
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
	export class UpdateInfo {
	    current_version: string;
	    latest_version: string;
	    update_available: boolean;
	    release_url: string;
	    release_notes: string;
	    published_at: string;
	
	    static createFrom(source: any = {}) {
	        return new UpdateInfo(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.current_version = source["current_version"];
	        this.latest_version = source["latest_version"];
	        this.update_available = source["update_available"];
	        this.release_url = source["release_url"];
	        this.release_notes = source["release_notes"];
	        this.published_at = source["published_at"];
	    }
	}

}

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
	    pending_verification?: boolean;
	
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
	        this.pending_verification = source["pending_verification"];
	    }
	}

}

export namespace neonsync {
	
	export class LinkShare {
	    AudienceID: string;
	    Secret: string;
	
	    static createFrom(source: any = {}) {
	        return new LinkShare(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.AudienceID = source["AudienceID"];
	        this.Secret = source["Secret"];
	    }
	}
	export class LinkShareInfo {
	    AudienceID: string;
	    ValidUntil: string;
	    Revoked: boolean;
	    CreatedAt: string;
	
	    static createFrom(source: any = {}) {
	        return new LinkShareInfo(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.AudienceID = source["AudienceID"];
	        this.ValidUntil = source["ValidUntil"];
	        this.Revoked = source["Revoked"];
	        this.CreatedAt = source["CreatedAt"];
	    }
	}
	export class TeamMember {
	    UserID: string;
	    Role: string;
	    Pinned: boolean;
	    DisplayName: string;
	    Status: string;
	
	    static createFrom(source: any = {}) {
	        return new TeamMember(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.UserID = source["UserID"];
	        this.Role = source["Role"];
	        this.Pinned = source["Pinned"];
	        this.DisplayName = source["DisplayName"];
	        this.Status = source["Status"];
	    }
	}
	export class ProjectShare {
	    Project: string;
	    AudienceIDs: string[];
	    Members: TeamMember[];
	
	    static createFrom(source: any = {}) {
	        return new ProjectShare(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.Project = source["Project"];
	        this.AudienceIDs = source["AudienceIDs"];
	        this.Members = this.convertValues(source["Members"], TeamMember);
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
	export class ShareView {
	    Projects: string[];
	    SinceDays: number;
	    HasShare: boolean;
	
	    static createFrom(source: any = {}) {
	        return new ShareView(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.Projects = source["Projects"];
	        this.SinceDays = source["SinceDays"];
	        this.HasShare = source["HasShare"];
	    }
	}
	export class SyncStatus {
	    configured: boolean;
	    enabled: boolean;
	    unlocked: boolean;
	    last_sync?: string;
	    entry_count: number;
	    error?: string;
	
	    static createFrom(source: any = {}) {
	        return new SyncStatus(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.configured = source["configured"];
	        this.enabled = source["enabled"];
	        this.unlocked = source["unlocked"];
	        this.last_sync = source["last_sync"];
	        this.entry_count = source["entry_count"];
	        this.error = source["error"];
	    }
	}

}

export namespace projects {
	
	export class Project {
	    name: string;
	    audience_id?: string;
	
	    static createFrom(source: any = {}) {
	        return new Project(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.name = source["name"];
	        this.audience_id = source["audience_id"];
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

