export class Watchdog {
  constructor({ enabled, failuresBeforeRestart, cooldownMs, provider, db, logger=console }) {
    this.enabled=enabled; this.failuresBeforeRestart=failuresBeforeRestart; this.cooldownMs=cooldownMs; this.provider=provider; this.db=db; this.logger=logger; this.lastRestartAt=0; this.busy=false;
  }
  async onFailure({consecutiveFailures}) {
    if(!this.enabled||this.busy||consecutiveFailures<this.failuresBeforeRestart)return false;
    if(Date.now()-this.lastRestartAt<this.cooldownMs)return false;
    const caps=this.provider?.capabilities?.()??{}; if(!caps.restart){this.logger.warn?.(`[watchdog] provider ${this.provider?.type??'unknown'} cannot restart`);return false;}
    this.busy=true;
    try{
      this.db?.audit('watchdog','server.restart.attempt','',`REST failed ${consecutiveFailures} consecutive times`);
      const result=await this.provider.restart(`PalControl watchdog: REST failed ${consecutiveFailures} checks`);
      this.lastRestartAt=Date.now(); this.db?.audit('watchdog','server.restart.executed','',JSON.stringify(result).slice(0,4000)); return true;
    }catch(err){this.db?.audit('watchdog','server.restart.failed','',err.message);this.logger.error('[watchdog]',err);return false;}finally{this.busy=false;}
  }
}
