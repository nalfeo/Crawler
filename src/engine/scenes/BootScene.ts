import Phaser from 'phaser';
import { MainGameScene } from './MainGameScene.js';

export class BootScene extends Phaser.Scene {
  static readonly KEY = 'BootScene';

  constructor() {
    super({ key: BootScene.KEY });
  }

  create(): void {
    this.scene.start(MainGameScene.KEY);
  }
}
