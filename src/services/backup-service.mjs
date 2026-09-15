import fs from 'node:fs/promises';
import path from 'node:path';
function stamp(d = new Date()) { return d.toISOString().replace(/[:.]/g,'-'); }

export class BackupService {
  constructor({ client, saveSource, savePath = '', backupDir, retention = 48, allowRestore = true, provider, db, logger = console }) {
    this.client=client; this.saveSource=saveSource || (savePath ? { enabled:true, remote:false, localSavePath:savePath, syncSaves:async()=>({mode:'local',path:savePath}), restoreFrom:async(localDir)=>{await fs.rm(savePath,{recursive:true,force:true});await fs.cp(localDir,savePath,{recursive:true,preserveTimestamps:true});return{mode:'local',target:savePath};} } : null); this.backupDir=backupDir; this.retention=retention; this.allowRestore=allowRestore; this.provider=provider; this.db=db; this.logger=logger;
  }
  get enabled(){ return Boolean(this.saveSource?.enabled); }
  async create(actor='system') {
    if (!this.enabled) throw new Error('No Palworld save source is configured.');
    await fs.mkdir(this.backupDir,{recursive:true});
    try { await this.client.save(); } catch (err) { this.logger.warn?.('[backup] REST save failed; continuing with latest persisted save:',err.message); }
    const synced = await this.saveSource.syncSaves();
    const source = this.saveSource.localSavePath;
    await fs.access(source);
    const name=`palworld-${stamp()}`; const dest=path.join(this.backupDir,name);
    await fs.cp(source,dest,{recursive:true,errorOnExist:true,preserveTimestamps:true});
    const manifest={name,createdAt:new Date().toISOString(),sourceMode:synced.mode,format:'directory-snapshot'};
    await fs.writeFile(path.join(dest,'palcontrol-backup.json'),JSON.stringify(manifest,null,2));
    this.db?.audit(actor,'backup.create',name,JSON.stringify(manifest));
    await this.prune(); return manifest;
  }
  async list(){
    if (!this.enabled) return [];
    await fs.mkdir(this.backupDir,{recursive:true}); const entries=await fs.readdir(this.backupDir,{withFileTypes:true}); const out=[];
    for(const e of entries.filter(e=>e.isDirectory()&&e.name.startsWith('palworld-'))){const full=path.join(this.backupDir,e.name);const st=await fs.stat(full);out.push({name:e.name,createdAt:st.birthtimeMs||st.mtimeMs,path:full});}
    return out.sort((a,b)=>b.createdAt-a.createdAt);
  }
  async prune(){const list=await this.list();for(const item of list.slice(this.retention))await fs.rm(item.path,{recursive:true,force:true});}
  async restore(name, actor='system') {
    if (!this.allowRestore) throw new Error('Backup restore is disabled by BACKUP_ALLOW_RESTORE=false.');
    if (!this.enabled) throw new Error('Backups are disabled.');
    if (!/^[A-Za-z0-9._-]+$/.test(name)) throw new Error('Invalid backup name.');
    const backup=path.join(this.backupDir,name); await fs.access(backup);
    const caps=this.provider?.capabilities?.() ?? {};
    if (!caps.stop || !caps.restart) throw new Error(`Safe restore needs provider stop + restart support. Provider ${this.provider?.type ?? 'unknown'} does not expose both.`);
    this.db?.audit(actor,'backup.restore.begin',name,'');
    await this.provider.stop(`PalControl restoring ${name}`);
    await new Promise(r=>setTimeout(r,2500));
    try {
      await this.saveSource.restoreFrom(backup);
      this.db?.audit(actor,'backup.restore.files',name,'uploaded/copied');
    } catch (err) {
      this.db?.audit(actor,'backup.restore.failed',name,err.message);
      throw err;
    } finally {
      try { await this.provider.restart(`PalControl restore ${name} complete`); } catch (err) { this.db?.audit(actor,'backup.restore.restart_failed',name,err.message); throw err; }
    }
    this.db?.audit(actor,'backup.restore.complete',name,'');
    return {ok:true,name};
  }
}
