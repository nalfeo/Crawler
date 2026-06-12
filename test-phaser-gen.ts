import Phaser from 'phaser';

const config = {
  type: Phaser.HEADLESS,
  width: 800,
  height: 600,
  scene: {
    preload: function () {
      console.log(Object.keys(this.textures));
    },
  },
};
