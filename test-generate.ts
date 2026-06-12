import Phaser from 'phaser';

class MyScene extends Phaser.Scene {
  create() {
    const data = ['..3..', '.333.', '3.3.3', '.333.', '..3..'];
    this.textures.generate('test', { data, pixelWidth: 2 });
    console.log(this.textures.exists('test'));
  }
}

new Phaser.Game({
  type: Phaser.HEADLESS,
  scene: MyScene,
  callbacks: {
    postBoot: () => {
      setTimeout(() => process.exit(0), 100);
    },
  },
});
